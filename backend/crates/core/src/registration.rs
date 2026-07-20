//! OWNER: be-detect — detection ↔ plant assignment, so plant ids stay stable across flights
//! (FR-P-003/FR-P-021; frozen definition in docs/API-PLANT.md §"Pipeline stages" → Registration).
//!
//! Pure: no DB, no ids. `arvo-core` has neither `uuid` nor a geometry crate, so callers pass
//! parallel slices of projected metric points and map the returned **indices** back to their
//! own rows. MUST ship `#[cfg(test)]` tests (docs/AGENTS.md rule 9).
//!
//! Determinism is a requirement, not a nicety: the same capture re-registered (a retry, a
//! resumed job) must produce the same plants. Two properties give that:
//!  * candidate pairs are accepted **nearest first**, which makes greedy assignment identical to
//!    iterated mutual-nearest-neighbour — a plant can never be claimed by two detections;
//!  * the sort key is the pair distance followed by the *coordinates* of both points (indices are
//!    only the last resort), so permuting the input rows cannot change the outcome.

use std::collections::HashMap;

/// Match radius = clamp(0.5 × median detection spacing, 1 m, 3 m).
pub const MATCH_RADIUS_FACTOR: f64 = 0.5;
pub const MATCH_RADIUS_MIN_M: f64 = 1.0;
pub const MATCH_RADIUS_MAX_M: f64 = 3.0;
/// Spacing assumed when a capture has fewer than two detections (nothing to measure from).
/// 4 m ≈ a mature orchard grid, and lands mid-range once the factor above is applied.
pub const DEFAULT_SPACING_M: f64 = 4.0;
/// Consecutive captures with no detection before a plant flips to `missing`. 2 → a single
/// capture never marks anything missing; this is `ReplantEntry.captures_absent`.
pub const MISSING_AFTER_CAPTURES: i32 = 2;

/// Local metric scale of a degree. Parcel-scale accuracy only — the plant tier never spans
/// more than a couple of km, where the equirectangular error stays well under a centimetre.
pub const M_PER_DEG_LAT: f64 = 110_540.0;
pub const M_PER_DEG_LON_EQUATOR: f64 = 111_320.0;

/// Cell rings scanned outward before a nearest-neighbour search gives up (spacing only).
const MAX_RINGS: i64 = 32;

/// A point in local metres (callers project lon/lat once — matching is metric).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

impl Point {
    pub fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }

    pub fn dist(self, other: Point) -> f64 {
        (self.x - other.x).hypot(self.y - other.y)
    }
}

/// One accepted pair: indices into the caller's slices plus the distance that matched them.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Match {
    pub detection: usize,
    pub plant: usize,
    pub dist_m: f64,
}

/// The full outcome of one capture's registration. Every index appears exactly once across the
/// three fields, and each field is sorted ascending, so applying it is order-independent too.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Assignment {
    /// Detection ↔ existing plant, `match_kind = 'matched'` (sorted by detection index).
    pub matched: Vec<Match>,
    /// Detections with no plant inside the radius → new plants, `match_kind = 'created'`.
    pub created: Vec<usize>,
    /// Plants with no detection → `missing_streak + 1` candidates (FR-P-022). The caller is
    /// responsible for restricting the `plants` slice to the capture's footprint: a plant the
    /// flight never overflew is not absent, it simply was not looked at.
    pub absent: Vec<usize>,
}

/// Local equirectangular projection about a reference point — the metric plane matching runs in.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Projection {
    pub lon0: f64,
    pub lat0: f64,
    m_per_deg_lon: f64,
}

impl Projection {
    pub fn about(lon0: f64, lat0: f64) -> Self {
        // cos() floored so a (nonsensical) polar origin can never collapse the x axis.
        let m_per_deg_lon = M_PER_DEG_LON_EQUATOR * lat0.to_radians().cos().abs().max(0.01);
        Self {
            lon0,
            lat0,
            m_per_deg_lon,
        }
    }

    /// Centre the projection on the mean of `lonlat`; `None` when the slice is empty.
    pub fn around(lonlat: &[(f64, f64)]) -> Option<Self> {
        if lonlat.is_empty() {
            return None;
        }
        let n = lonlat.len() as f64;
        let lon0 = lonlat.iter().map(|p| p.0).sum::<f64>() / n;
        let lat0 = lonlat.iter().map(|p| p.1).sum::<f64>() / n;
        Some(Self::about(lon0, lat0))
    }

    pub fn point(&self, lon: f64, lat: f64) -> Point {
        Point::new(
            (lon - self.lon0) * self.m_per_deg_lon,
            (lat - self.lat0) * M_PER_DEG_LAT,
        )
    }
}

pub fn match_radius_m(median_spacing_m: f64) -> f64 {
    let spacing = if median_spacing_m.is_finite() && median_spacing_m > 0.0 {
        median_spacing_m
    } else {
        DEFAULT_SPACING_M
    };
    (MATCH_RADIUS_FACTOR * spacing).clamp(MATCH_RADIUS_MIN_M, MATCH_RADIUS_MAX_M)
}

/// The radius this capture registers with: half the plants' own spacing, clamped. Derived from
/// the detections (not a config value) so a vineyard and an orchard both behave sanely.
pub fn match_radius_for(detections: &[Point]) -> f64 {
    match_radius_m(median_spacing_m(detections).unwrap_or(DEFAULT_SPACING_M))
}

/// Median nearest-neighbour distance of a point set — the plant spacing the match radius scales
/// from. `None` for fewer than two points. Median (not mean) so a few stragglers at the parcel
/// edge cannot stretch the radius.
pub fn median_spacing_m(points: &[Point]) -> Option<f64> {
    if points.len() < 2 {
        return None;
    }
    let (mut min_x, mut max_x, mut min_y, mut max_y) = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
    for p in points {
        min_x = min_x.min(p.x);
        max_x = max_x.max(p.x);
        min_y = min_y.min(p.y);
        max_y = max_y.max(p.y);
    }
    // Aim for ~one point per cell so the ring search below stops after a ring or two.
    let span = (max_x - min_x).max(max_y - min_y);
    let cell = if span.is_finite() && span > 0.0 {
        (span / (points.len() as f64).sqrt()).max(1e-6)
    } else {
        1.0
    };
    let grid = Grid::build(points, cell);
    let mut d: Vec<f64> = (0..points.len())
        .filter_map(|i| grid.nearest_other(points, i))
        .collect();
    if d.is_empty() {
        return None;
    }
    d.sort_by(f64::total_cmp);
    let mid = d.len() / 2;
    Some(if d.len().is_multiple_of(2) {
        (d[mid - 1] + d[mid]) / 2.0
    } else {
        d[mid]
    })
}

/// True once a plant has been absent from [`MISSING_AFTER_CAPTURES`] consecutive captures that
/// covered it — the point at which `status` flips to `missing`.
pub fn is_missing(missing_streak: i32) -> bool {
    missing_streak >= MISSING_AFTER_CAPTURES
}

/// Greedy mutual nearest neighbour between this capture's detections and the parcel's existing
/// plants, inside `radius_m`. Deterministic for a given input order. Detections absent from the
/// result are new plants; plants absent from it are candidates for `missing_streak + 1`.
pub fn match_detections(detections: &[Point], plants: &[Point], radius_m: f64) -> Vec<Match> {
    assign(detections, plants, radius_m).matched
}

/// [`match_detections`] plus the leftovers classified (FR-P-021/FR-P-022).
///
/// Pairs closer than `radius_m` are accepted nearest-first; a detection and a plant are each
/// consumed by their first accepted pair, which is exactly the mutual-nearest-neighbour result
/// and guarantees no plant is claimed twice. The matching is maximal, not maximum-cardinality:
/// a nearer pair is always preferred to a larger one, because identity beats count here.
pub fn assign(detections: &[Point], plants: &[Point], radius_m: f64) -> Assignment {
    let mut candidates: Vec<Match> = Vec::new();
    if radius_m.is_finite() && radius_m > 0.0 && !detections.is_empty() && !plants.is_empty() {
        let grid = Grid::build(plants, radius_m);
        for (d, det) in detections.iter().enumerate() {
            grid.for_each_within(*det, radius_m, plants, |plant, dist_m| {
                candidates.push(Match {
                    detection: d,
                    plant,
                    dist_m,
                })
            });
        }
        // Total order: distance, then both points' coordinates, then the indices. Coordinates
        // before indices is what makes the result invariant under a permuted input.
        candidates.sort_by(|a, b| {
            let (da, pa) = (detections[a.detection], plants[a.plant]);
            let (db, pb) = (detections[b.detection], plants[b.plant]);
            a.dist_m
                .total_cmp(&b.dist_m)
                .then(da.x.total_cmp(&db.x))
                .then(da.y.total_cmp(&db.y))
                .then(pa.x.total_cmp(&pb.x))
                .then(pa.y.total_cmp(&pb.y))
                .then(a.detection.cmp(&b.detection))
                .then(a.plant.cmp(&b.plant))
        });
    }

    let mut det_taken = vec![false; detections.len()];
    let mut plant_taken = vec![false; plants.len()];
    let mut matched = Vec::new();
    for c in candidates {
        if det_taken[c.detection] || plant_taken[c.plant] {
            continue;
        }
        det_taken[c.detection] = true;
        plant_taken[c.plant] = true;
        matched.push(c);
    }
    matched.sort_by_key(|m| m.detection);

    Assignment {
        matched,
        created: (0..detections.len()).filter(|i| !det_taken[*i]).collect(),
        absent: (0..plants.len()).filter(|i| !plant_taken[*i]).collect(),
    }
}

// --- uniform grid -----------------------------------------------------------
// Tens of thousands of plants per parcel (NFR-P-SCALE) rules out the O(n·m) pairwise scan; a
// hashed uniform grid keeps registration linear in the number of *nearby* pairs. Buckets are
// filled in index order and only ever looked up, never iterated, so nothing here depends on
// HashMap ordering.

struct Grid {
    cell: f64,
    buckets: HashMap<(i64, i64), Vec<usize>>,
}

impl Grid {
    fn build(points: &[Point], cell: f64) -> Self {
        let cell = if cell.is_finite() && cell > 0.0 {
            cell
        } else {
            1.0
        };
        let mut buckets: HashMap<(i64, i64), Vec<usize>> = HashMap::new();
        for (i, p) in points.iter().enumerate() {
            buckets.entry(cell_of(*p, cell)).or_default().push(i);
        }
        Self { cell, buckets }
    }

    fn for_each_within(
        &self,
        from: Point,
        radius: f64,
        points: &[Point],
        mut f: impl FnMut(usize, f64),
    ) {
        let (cx, cy) = cell_of(from, self.cell);
        let span = (radius / self.cell).ceil().max(1.0) as i64;
        for gx in cx - span..=cx + span {
            for gy in cy - span..=cy + span {
                let Some(bucket) = self.buckets.get(&(gx, gy)) else {
                    continue;
                };
                for &i in bucket {
                    let d = from.dist(points[i]);
                    if d <= radius {
                        f(i, d);
                    }
                }
            }
        }
    }

    /// Distance to the nearest point other than `i`. Rings are scanned outward and the search
    /// only stops once the best hit is closer than the ring itself could hide — so the answer is
    /// exact, not a "close enough in the 3×3 neighbourhood" approximation.
    fn nearest_other(&self, points: &[Point], i: usize) -> Option<f64> {
        let from = points[i];
        let (cx, cy) = cell_of(from, self.cell);
        let mut best = f64::INFINITY;
        let mut k: i64 = 0;
        loop {
            for gx in cx - k..=cx + k {
                for gy in cy - k..=cy + k {
                    if (gx - cx).abs() != k && (gy - cy).abs() != k {
                        continue; // interior of the square — already scanned by a smaller ring
                    }
                    let Some(bucket) = self.buckets.get(&(gx, gy)) else {
                        continue;
                    };
                    for &j in bucket {
                        if j != i {
                            best = best.min(from.dist(points[j]));
                        }
                    }
                }
            }
            // Anything still unscanned sits at least k cells away.
            if best.is_finite() && best <= k as f64 * self.cell {
                break;
            }
            if k >= MAX_RINGS {
                break;
            }
            k += 1;
        }
        best.is_finite().then_some(best)
    }
}

fn cell_of(p: Point, cell: f64) -> (i64, i64) {
    ((p.x / cell).floor() as i64, (p.y / cell).floor() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A regular 5 m orchard grid, `n × n` plants.
    fn grid(n: usize, spacing: f64) -> Vec<Point> {
        let mut v = Vec::with_capacity(n * n);
        for r in 0..n {
            for c in 0..n {
                v.push(Point::new(c as f64 * spacing, r as f64 * spacing));
            }
        }
        v
    }

    fn pairs(a: &Assignment, det: &[Point], pl: &[Point]) -> Vec<(String, String)> {
        a.matched
            .iter()
            .map(|m| {
                let (d, p) = (det[m.detection], pl[m.plant]);
                (
                    format!("{:.3},{:.3}", d.x, d.y),
                    format!("{:.3},{:.3}", p.x, p.y),
                )
            })
            .collect()
    }

    #[test]
    fn match_radius_clamps_to_the_frozen_range() {
        assert_eq!(match_radius_m(4.0), 2.0); // 0.5 × spacing
        assert_eq!(match_radius_m(0.5), MATCH_RADIUS_MIN_M); // tight vineyard spacing
        assert_eq!(match_radius_m(20.0), MATCH_RADIUS_MAX_M); // wide orchard spacing
        assert_eq!(match_radius_m(f64::NAN), match_radius_m(DEFAULT_SPACING_M));
        assert_eq!(match_radius_m(0.0), match_radius_m(DEFAULT_SPACING_M));
    }

    #[test]
    fn exact_match_pairs_every_detection_with_its_plant() {
        let plants = grid(4, 5.0);
        let detections = plants.clone();
        let a = assign(&detections, &plants, 2.0);
        assert_eq!(a.matched.len(), 16);
        assert!(a.created.is_empty() && a.absent.is_empty());
        // identity is preserved: plant k keeps detection k
        for m in &a.matched {
            assert_eq!(m.detection, m.plant);
            assert!(m.dist_m < 1e-9);
        }
    }

    #[test]
    fn small_drift_still_matches_the_same_plants() {
        let plants = grid(4, 5.0);
        // GPS/ortho drift of ~40 cm — well inside the 2 m radius, well under the spacing.
        let detections: Vec<Point> = plants
            .iter()
            .map(|p| Point::new(p.x + 0.4, p.y - 0.3))
            .collect();
        let a = assign(&detections, &plants, 2.0);
        assert_eq!(a.matched.len(), 16);
        assert!(a.created.is_empty() && a.absent.is_empty());
        for m in &a.matched {
            assert_eq!(m.detection, m.plant, "drift must not shuffle identities");
            assert!((m.dist_m - 0.5).abs() < 1e-9);
        }
    }

    #[test]
    fn a_genuinely_new_plant_is_created_not_forced_onto_a_neighbour() {
        let plants = grid(3, 5.0); // 9 plants
        let mut detections = plants.clone();
        detections.push(Point::new(2.5, 12.5)); // an interplant, > radius from every plant
        let a = assign(&detections, &plants, 2.0);
        assert_eq!(a.matched.len(), 9);
        assert_eq!(a.created, vec![9]);
        assert!(a.absent.is_empty());
    }

    #[test]
    fn a_plant_with_no_detection_is_reported_absent() {
        let plants = grid(3, 5.0);
        let detections: Vec<Point> = plants
            .iter()
            .enumerate()
            .filter(|(i, _)| *i != 4)
            .map(|(_, p)| *p)
            .collect();
        let a = assign(&detections, &plants, 2.0);
        assert_eq!(a.matched.len(), 8);
        assert!(a.created.is_empty());
        assert_eq!(a.absent, vec![4]);
        assert!(!is_missing(1), "one capture never marks a plant missing");
        assert!(is_missing(MISSING_AFTER_CAPTURES));
    }

    #[test]
    fn two_detections_cannot_claim_the_same_plant() {
        let plants = vec![Point::new(0.0, 0.0)];
        // Both inside the radius; the nearer one wins, the other becomes a new plant.
        let detections = vec![Point::new(1.2, 0.0), Point::new(0.3, 0.0)];
        let a = assign(&detections, &plants, 2.0);
        assert_eq!(a.matched.len(), 1);
        assert_eq!(a.matched[0].detection, 1);
        assert_eq!(a.matched[0].plant, 0);
        assert_eq!(a.created, vec![0]);
        assert!(a.absent.is_empty());
    }

    #[test]
    fn two_plants_cannot_be_claimed_by_the_same_detection() {
        let plants = vec![Point::new(0.0, 0.0), Point::new(1.0, 0.0)];
        let detections = vec![Point::new(0.9, 0.0)];
        let a = assign(&detections, &plants, 2.0);
        assert_eq!(a.matched.len(), 1);
        assert_eq!(a.matched[0].plant, 1, "nearest plant wins");
        assert_eq!(a.absent, vec![0]);
        assert!(a.created.is_empty());
    }

    #[test]
    fn nearest_first_beats_a_larger_matching() {
        // d0 is 0.1 m from p0; d1 is 1.5 m from p0 and 1.9 m from p1. Nearest-first takes
        // (d0,p0) then (d1,p1) — both matched. The pathological order (d1,p0) is never chosen.
        let plants = vec![Point::new(0.0, 0.0), Point::new(3.4, 0.0)];
        let detections = vec![Point::new(0.1, 0.0), Point::new(1.5, 0.0)];
        let a = assign(&detections, &plants, 2.0);
        assert_eq!(a.matched.len(), 2);
        assert_eq!(a.matched[0].plant, 0);
        assert_eq!(a.matched[1].plant, 1);
    }

    #[test]
    fn beyond_the_radius_nothing_matches() {
        let plants = vec![Point::new(0.0, 0.0)];
        let detections = vec![Point::new(2.01, 0.0)];
        let a = assign(&detections, &plants, 2.0);
        assert!(a.matched.is_empty());
        assert_eq!(a.created, vec![0]);
        assert_eq!(a.absent, vec![0]);
    }

    #[test]
    fn empty_inputs_are_not_a_special_case() {
        assert_eq!(assign(&[], &[], 2.0), Assignment::default());

        let plants = grid(2, 5.0);
        let a = assign(&[], &plants, 2.0);
        assert!(a.matched.is_empty() && a.created.is_empty());
        assert_eq!(a.absent, vec![0, 1, 2, 3]);

        let b = assign(&plants, &[], 2.0);
        assert!(b.matched.is_empty() && b.absent.is_empty());
        assert_eq!(b.created, vec![0, 1, 2, 3]);

        // A degenerate radius must not match anything rather than panic.
        let c = assign(&plants, &plants, 0.0);
        assert!(c.matched.is_empty());
        assert_eq!(c.created.len(), 4);
        assert_eq!(c.absent.len(), 4);
    }

    #[test]
    fn result_does_not_depend_on_input_order() {
        let plants = grid(6, 5.0);
        let detections: Vec<Point> = plants
            .iter()
            .map(|p| Point::new(p.x + 0.35, p.y + 0.25))
            .collect();
        let base = assign(&detections, &plants, 2.0);

        // Reverse both slices: indices change, the *pairing* must not.
        let rev_d: Vec<Point> = detections.iter().rev().copied().collect();
        let rev_p: Vec<Point> = plants.iter().rev().copied().collect();
        let flipped = assign(&rev_d, &rev_p, 2.0);

        let mut a = pairs(&base, &detections, &plants);
        let mut b = pairs(&flipped, &rev_d, &rev_p);
        a.sort();
        b.sort();
        assert_eq!(a, b);
    }

    #[test]
    fn repeated_runs_are_bit_identical() {
        let plants = grid(5, 5.0);
        let detections: Vec<Point> = plants
            .iter()
            .map(|p| Point::new(p.x - 0.2, p.y + 0.6))
            .collect();
        let a = assign(&detections, &plants, 2.0);
        let b = assign(&detections, &plants, 2.0);
        assert_eq!(a, b);
    }

    #[test]
    fn a_realistic_flight_matches_creates_and_misses_at_once() {
        let plants = grid(10, 5.0); // 100 planted trees
        let mut detections: Vec<Point> = plants
            .iter()
            .enumerate()
            .filter(|(i, _)| *i != 33 && *i != 77) // two absent this flight
            .map(|(i, p)| {
                let s = if i % 2 == 0 { 0.25 } else { -0.3 };
                Point::new(p.x + s, p.y + s / 2.0)
            })
            .collect();
        detections.push(Point::new(22.5, 2.5)); // a replant between two rows

        // ~0.5 × the 5 m grid spacing; the alternating jitter moves the measured spacing a little.
        let radius = match_radius_for(&detections);
        assert!((radius - 2.5).abs() < 0.4, "radius {radius}");
        let a = assign(&detections, &plants, radius);
        assert_eq!(a.matched.len(), 98);
        assert_eq!(a.created.len(), 1);
        assert_eq!(a.absent, vec![33, 77]);
    }

    #[test]
    fn median_spacing_measures_the_planting_grid() {
        let g = grid(8, 5.0);
        let s = median_spacing_m(&g).unwrap();
        assert!((s - 5.0).abs() < 1e-9, "spacing {s}");
        assert_eq!(median_spacing_m(&g[..1]), None);
        assert_eq!(median_spacing_m(&[]), None);

        // Vineyard: 1 m along the row, 2.5 m between rows → nearest neighbour is 1 m.
        let vines: Vec<Point> = (0..4)
            .flat_map(|r| (0..20).map(move |c| Point::new(c as f64, r as f64 * 2.5)))
            .collect();
        let vs = median_spacing_m(&vines).unwrap();
        assert!((vs - 1.0).abs() < 1e-9, "vine spacing {vs}");
        assert_eq!(match_radius_m(vs), MATCH_RADIUS_MIN_M);
    }

    #[test]
    fn median_spacing_is_exact_for_clustered_points() {
        // Two tight clusters far apart: the ring search must not stop at the first ring and
        // report the cluster gap for the isolated point.
        let pts = vec![
            Point::new(0.0, 0.0),
            Point::new(0.5, 0.0),
            Point::new(1.0, 0.0),
            Point::new(400.0, 0.0),
            Point::new(400.5, 0.0),
        ];
        let s = median_spacing_m(&pts).unwrap();
        assert!((s - 0.5).abs() < 1e-9, "spacing {s}");
    }

    #[test]
    fn projection_is_metric_around_its_origin() {
        let p = Projection::about(15.85, 41.45); // the demo farm, Foggia plain
        let o = p.point(15.85, 41.45);
        assert!(o.x.abs() < 1e-9 && o.y.abs() < 1e-9);

        // One degree of latitude ≈ 110.5 km; one degree of longitude shrinks with cos(lat).
        let north = p.point(15.85, 42.45);
        assert!((north.y - M_PER_DEG_LAT).abs() < 1.0);
        let east = p.point(16.85, 41.45);
        assert!((east.x - 83_400.0).abs() < 500.0, "east {}", east.x);

        // A 2 m offset in latitude must read as 2 m.
        let two_m = p.point(15.85, 41.45 + 2.0 / M_PER_DEG_LAT);
        assert!((two_m.dist(o) - 2.0).abs() < 1e-6);

        let around = Projection::around(&[(10.0, 40.0), (12.0, 42.0)]).unwrap();
        assert_eq!((around.lon0, around.lat0), (11.0, 41.0));
        assert_eq!(Projection::around(&[]), None);
    }

    #[test]
    fn projected_lonlat_registration_round_trips() {
        // Same orchard expressed as lon/lat, drifted by ~0.5 m between flights.
        let proj = Projection::about(15.85, 41.45);
        let dlat = 5.0 / M_PER_DEG_LAT;
        let dlon = 5.0 / (M_PER_DEG_LON_EQUATOR * (41.45f64).to_radians().cos());
        let lonlat: Vec<(f64, f64)> = (0..5)
            .flat_map(|r| (0..5).map(move |c| (15.85 + c as f64 * dlon, 41.45 + r as f64 * dlat)))
            .collect();
        let plants: Vec<Point> = lonlat.iter().map(|(x, y)| proj.point(*x, *y)).collect();
        let detections: Vec<Point> = lonlat
            .iter()
            .map(|(x, y)| proj.point(x + 0.3 * dlon / 5.0, y - 0.4 * dlat / 5.0))
            .collect();

        let radius = match_radius_for(&detections);
        assert!((radius - 2.5).abs() < 1e-6, "radius {radius}");
        let a = assign(&detections, &plants, radius);
        assert_eq!(a.matched.len(), 25);
        assert!(a.created.is_empty() && a.absent.is_empty());
        for m in &a.matched {
            assert_eq!(m.detection, m.plant);
            assert!(m.dist_m < 0.6, "dist {}", m.dist_m);
        }
    }

    #[test]
    fn match_detections_is_the_matched_half_of_assign() {
        let plants = grid(3, 5.0);
        let detections = plants.clone();
        assert_eq!(
            match_detections(&detections, &plants, 2.0),
            assign(&detections, &plants, 2.0).matched
        );
    }
}
