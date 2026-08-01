//! OWNER: be-cadastre — cadastral parcel detection for onboarding (FR-0-010b).
//! Proxies the INSPIRE WFS of Agenzia delle Entrate (open data, CC-BY 4.0, no key) and
//! returns viewport cadastral parcels as GeoJSON, annotated with the org's existing fields
//! so the app can offer only NEW parcels for one-tap onboarding. GML lives and dies here;
//! nothing upstream of this module ever sees XML.
use axum::extract::{Query, State};
use axum::routing::get;
use axum::{Json, Router};
use quick_xml::events::Event;
use quick_xml::Reader;
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::security::AuthUser;
use crate::state::AppState;

/// Upstream feature cap: a viewport at onboarding zoom holds a few dozen parcels; more
/// means the bbox is too wide to tap parcels anyway, so we truncate and say so.
const MAX_FEATURES: usize = 60;
/// Max bbox span in degrees (~7 km): protects the public WFS while still covering a wide
/// portal viewport at the app's minimum detection zoom (15). COUNT caps the payload anyway.
const MAX_SPAN_DEG: f64 = 0.08;
/// Coverage of the default provider (Italy, generously bounded).
const IT_LON: (f64, f64) = (6.0, 19.5);
const IT_LAT: (f64, f64) = (35.0, 48.0);
const UPSTREAM_TIMEOUT_SECS: u64 = 15;

pub fn router() -> Router<AppState> {
    Router::new().route("/cadastre/parcels", get(detect))
}

#[derive(Deserialize)]
struct DetectQuery {
    /// `w,s,e,n` in EPSG:4326 (GeoJSON axis order), i.e. the map viewport.
    bbox: String,
}

/// GET /cadastre/parcels?bbox=w,s,e,n — cadastral parcels in the viewport as a GeoJSON
/// FeatureCollection. Each feature carries `cadastral_ref`, `label`, `area_m2` and
/// `existing_parcel_id` (an org parcel that already covers it, else null).
async fn detect(
    State(st): State<AppState>,
    user: AuthUser,
    Query(q): Query<DetectQuery>,
) -> ApiResult<Json<Value>> {
    let bbox = parse_bbox(&q.bbox)?;

    let gml = fetch_wfs(&st.cfg.cadastre_wfs_url, bbox).await?;
    let mut feats = parse_cadastral_gml(&gml)
        .map_err(|e| ApiError::Upstream(format!("cadastre response not understood: {e}")))?;
    let truncated = feats.len() >= MAX_FEATURES;
    feats.truncate(MAX_FEATURES);

    let existing = match_existing(&st, user.org_id, &feats).await?;

    let features: Vec<Value> = feats
        .iter()
        .enumerate()
        .map(|(i, f)| {
            json!({
                "type": "Feature",
                "geometry": f.geometry_geojson(),
                "properties": {
                    "cadastral_ref": f.reference,
                    "label": f.label,
                    "area_m2": f.area_m2,
                    "existing_parcel_id": existing.get(&i),
                },
            })
        })
        .collect();

    Ok(Json(json!({
        "type": "FeatureCollection",
        "features": features,
        "truncated": truncated,
        "source": "agenzia-entrate-inspire",
    })))
}

/// Parse and sanity-check `w,s,e,n`. Rejects malformed input, empty/oversized extents and
/// viewports outside the provider's coverage (Italy) with actionable messages.
fn parse_bbox(raw: &str) -> ApiResult<[f64; 4]> {
    let parts: Vec<f64> = raw
        .split(',')
        .map(|p| p.trim().parse::<f64>())
        .collect::<Result<_, _>>()
        .map_err(|_| ApiError::BadRequest("bbox must be four numbers: w,s,e,n".into()))?;
    let [w, s, e, n]: [f64; 4] = parts
        .try_into()
        .map_err(|_| ApiError::BadRequest("bbox must be four numbers: w,s,e,n".into()))?;
    if !(w.is_finite() && s.is_finite() && e.is_finite() && n.is_finite()) || w >= e || s >= n {
        return Err(ApiError::BadRequest(
            "bbox must be a non-empty w,s,e,n extent".into(),
        ));
    }
    if (e - w) > MAX_SPAN_DEG || (n - s) > MAX_SPAN_DEG {
        return Err(ApiError::BadRequest(
            "bbox too wide — zoom in to detect cadastral parcels".into(),
        ));
    }
    if e < IT_LON.0 || w > IT_LON.1 || n < IT_LAT.0 || s > IT_LAT.1 {
        return Err(ApiError::BadRequest(
            "cadastral detection covers Italy only for now".into(),
        ));
    }
    Ok([w, s, e, n])
}

/// The AdE service publishes EXACTLY one CRS (its GetCapabilities DefaultCRS, no OtherCRS):
/// RDN2008 geographic. Requesting EPSG::4326 is rejected as InvalidFormat. RDN2008 is
/// ETRS89-based — within centimeters of WGS84 over Italy — so we ask in 6706 and treat the
/// coordinates as 4326 on both legs.
const WFS_CRS: &str = "urn:ogc:def:crs:EPSG::6706";

/// WFS 2.0 GetFeature over the configured endpoint. BBOX uses the EPSG::6706 urn, whose
/// axis order is latitude first — hence s,w,n,e.
async fn fetch_wfs(base: &str, [w, s, e, n]: [f64; 4]) -> ApiResult<String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(UPSTREAM_TIMEOUT_SECS))
        .build()
        .map_err(|e| ApiError::Internal(e.into()))?;
    let resp = client
        .get(base)
        .query(&[
            ("SERVICE", "WFS"),
            ("VERSION", "2.0.0"),
            ("REQUEST", "GetFeature"),
            ("TYPENAMES", "CP:CadastralParcel"),
            ("SRSNAME", WFS_CRS),
            ("BBOX", &format!("{s},{w},{n},{e},{WFS_CRS}")),
            ("COUNT", &MAX_FEATURES.to_string()),
        ])
        .send()
        .await
        .map_err(|e| ApiError::Upstream(format!("cadastre service unreachable: {e}")))?;
    if !resp.status().is_success() {
        return Err(ApiError::Upstream(format!(
            "cadastre service answered {}",
            resp.status()
        )));
    }
    resp.text()
        .await
        .map_err(|e| ApiError::Upstream(format!("cadastre response unreadable: {e}")))
}

// ---------- GML → GeoJSON ----------

#[derive(Debug, Default)]
struct CadastralFeature {
    reference: Option<String>,
    label: Option<String>,
    area_m2: Option<f64>,
    /// One entry per polygon: rings[0] = exterior, rest = holes. Lon/lat order.
    polygons: Vec<Vec<Vec<[f64; 2]>>>,
}

impl CadastralFeature {
    fn geometry_geojson(&self) -> Value {
        if self.polygons.len() == 1 {
            json!({ "type": "Polygon", "coordinates": self.polygons[0] })
        } else {
            json!({ "type": "MultiPolygon", "coordinates": self.polygons })
        }
    }
}

/// Which ring the next posList belongs to. INSPIRE emits both `gml:Polygon` and
/// `gml:Surface/gml:patches/gml:PolygonPatch`; `exterior`/`interior` wrappers are common to
/// both, so tracking only those keeps the parser agnostic to the surface flavor.
#[derive(Clone, Copy, PartialEq)]
enum RingCtx {
    None,
    Exterior,
    Interior,
}

/// Streaming, namespace-agnostic parse of a WFS GetFeature GML document into features.
/// Element matching is case-insensitive: canonical INSPIRE emits `nationalCadastralReference`
/// while the AdE MapServer deployment emits `NATIONALCADASTRALREFERENCE`. Anything
/// unexpected is skipped, not fatal — a partial answer beats a dead onboarding — but an OGC
/// exception document (which is well-formed XML with zero members) must surface as an error,
/// never as "no parcels here".
fn parse_cadastral_gml(xml: &str) -> Result<Vec<CadastralFeature>, String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    let mut features: Vec<CadastralFeature> = Vec::new();
    let mut current: Option<CadastralFeature> = None;
    let mut ring = RingCtx::None;
    // Lowercased local name of the element whose text we are collecting.
    let mut capture: Option<&'static str> = None;
    let mut text = String::new();
    let mut exception: Option<String> = None;

    loop {
        match reader.read_event() {
            Ok(Event::Start(el)) => {
                let qname = el.name();
                let name = local_name(qname.as_ref());
                match name.as_str() {
                    "cadastralparcel" => {
                        current = Some(CadastralFeature::default());
                        ring = RingCtx::None;
                    }
                    "exterior" => ring = RingCtx::Exterior,
                    "interior" => ring = RingCtx::Interior,
                    "poslist" if current.is_some() => {
                        capture = Some("poslist");
                        text.clear();
                    }
                    "nationalcadastralreference" if current.is_some() => {
                        capture = Some("nationalcadastralreference");
                        text.clear();
                    }
                    "label" if current.is_some() => {
                        capture = Some("label");
                        text.clear();
                    }
                    "areavalue" if current.is_some() => {
                        capture = Some("areavalue");
                        text.clear();
                    }
                    // OGC error envelopes: ServiceExceptionReport/ServiceException (WMS-era,
                    // what AdE's MapServer emits) and ows:ExceptionReport/ExceptionText.
                    "serviceexception" | "exceptiontext" => {
                        capture = Some("exception");
                        text.clear();
                    }
                    _ => {}
                }
            }
            Ok(Event::Text(t)) => {
                if capture.is_some() {
                    text.push_str(&t.unescape().map_err(|e| e.to_string())?);
                    text.push(' ');
                }
            }
            Ok(Event::CData(t)) => {
                if capture.is_some() {
                    text.push_str(&String::from_utf8_lossy(&t));
                    text.push(' ');
                }
            }
            Ok(Event::End(el)) => {
                let qname = el.name();
                let name = local_name(qname.as_ref());
                match (name.as_str(), capture) {
                    ("poslist", Some("poslist")) => {
                        if let (Some(f), Some(r)) = (current.as_mut(), parse_pos_list(&text)) {
                            match ring {
                                RingCtx::Interior if !f.polygons.is_empty() => {
                                    f.polygons.last_mut().unwrap().push(r);
                                }
                                // Exterior — and tolerate a bare posList with no wrapper.
                                _ => f.polygons.push(vec![r]),
                            }
                        }
                        capture = None;
                    }
                    ("nationalcadastralreference", Some("nationalcadastralreference")) => {
                        if let Some(f) = current.as_mut() {
                            f.reference = Some(text.trim().to_string());
                        }
                        capture = None;
                    }
                    ("label", Some("label")) => {
                        if let Some(f) = current.as_mut() {
                            f.label = Some(text.trim().to_string());
                        }
                        capture = None;
                    }
                    ("areavalue", Some("areavalue")) => {
                        if let Some(f) = current.as_mut() {
                            f.area_m2 = text.trim().parse().ok();
                        }
                        capture = None;
                    }
                    ("serviceexception" | "exceptiontext", Some("exception")) => {
                        exception = Some(text.trim().to_string());
                        capture = None;
                    }
                    ("exterior" | "interior", _) => ring = RingCtx::None,
                    ("cadastralparcel", _) => {
                        if let Some(f) = current.take() {
                            if !f.polygons.is_empty() {
                                features.push(f);
                            }
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("invalid XML: {e}")),
            _ => {}
        }
    }
    if features.is_empty() {
        if let Some(msg) = exception {
            return Err(format!("service exception: {msg}"));
        }
    }
    Ok(features)
}

fn local_name(qname: &[u8]) -> String {
    let full = std::str::from_utf8(qname).unwrap_or("");
    full.rsplit(':').next().unwrap_or(full).to_ascii_lowercase()
}

/// Parse a `gml:posList` into a closed lon/lat ring.
///
/// Axis order: the EPSG::4326/6706 urns mandate lat,lon, but real WFS servers disagree.
/// Over Italy the two axes never overlap numerically (lon ≤ 19.5 < 35 ≤ lat), so the first
/// pair disambiguates the whole ring; pairs outside both ranges fall back to lat,lon.
fn parse_pos_list(raw: &str) -> Option<Vec<[f64; 2]>> {
    let nums: Vec<f64> = raw
        .split_whitespace()
        .filter_map(|t| t.parse::<f64>().ok())
        .collect();
    if nums.len() < 8 || !nums.len().is_multiple_of(2) {
        return None; // fewer than 4 points is not a ring
    }
    let (a, b) = (nums[0], nums[1]);
    let lat_first = if a > IT_LON.1 && b <= IT_LON.1 {
        true
    } else if b > IT_LON.1 && a <= IT_LON.1 {
        false
    } else {
        true // declared order of the urn CRS
    };
    let mut ring: Vec<[f64; 2]> = nums
        .chunks_exact(2)
        .map(|c| {
            if lat_first {
                [c[1], c[0]]
            } else {
                [c[0], c[1]]
            }
        })
        .collect();
    if ring.first() != ring.last() {
        let first = ring[0];
        ring.push(first);
    }
    if ring.len() < 4 {
        return None;
    }
    Some(ring)
}

// ---------- overlap with the org's fields ----------

/// For each candidate, find an org parcel that already covers it: same cadastral_ref, or
/// spatial overlap > 50% of the candidate's area. One round trip for the whole batch.
async fn match_existing(
    st: &AppState,
    org_id: Uuid,
    feats: &[CadastralFeature],
) -> ApiResult<std::collections::HashMap<usize, Uuid>> {
    let mut out = std::collections::HashMap::new();
    if feats.is_empty() {
        return Ok(out);
    }
    let ords: Vec<i32> = (0..feats.len() as i32).collect();
    let refs: Vec<Option<String>> = feats.iter().map(|f| f.reference.clone()).collect();
    let geoms: Vec<String> = feats
        .iter()
        .map(|f| f.geometry_geojson().to_string())
        .collect();

    let rows: Vec<(i32, Uuid)> = sqlx::query_as(
        "WITH cand AS (
            SELECT t.ord, t.ref,
                   ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(t.gj), 4326)) AS g
            FROM UNNEST($2::int[], $3::text[], $4::text[]) AS t(ord, ref, gj)
        )
        SELECT DISTINCT ON (c.ord) c.ord, p.id
        FROM cand c
        JOIN parcels p
          ON p.org_id = $1 AND p.archived = false
         AND (
              (c.ref IS NOT NULL AND p.cadastral_ref = c.ref)
           OR ST_Area(ST_Intersection(p.geom, c.g)) > 0.5 * NULLIF(ST_Area(c.g), 0)
         )
        ORDER BY c.ord, p.created_at",
    )
    .bind(org_id)
    .bind(&ords)
    .bind(&refs)
    .bind(&geoms)
    .fetch_all(&st.pool)
    .await?;

    for (ord, id) in rows {
        out.insert(ord as usize, id);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// INSPIRE-flavored sample: one Surface/patches parcel with a hole (lat,lon order) and
    /// one plain Polygon parcel (lon,lat order) — both must come out as lon/lat GeoJSON.
    const SAMPLE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0"
  xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:CP="http://mapserver.gis.umn.edu/mapserver">
  <wfs:member>
    <CP:CadastralParcel gml:id="CP.1">
      <CP:geometry>
        <gml:MultiSurface srsName="urn:ogc:def:crs:EPSG::4326">
          <gml:surfaceMember>
            <gml:Surface><gml:patches><gml:PolygonPatch>
              <gml:exterior><gml:LinearRing>
                <gml:posList>41.4514 15.8478 41.4514 15.8522 41.4526 15.8522 41.4526 15.8478 41.4514 15.8478</gml:posList>
              </gml:LinearRing></gml:exterior>
              <gml:interior><gml:LinearRing>
                <gml:posList>41.4518 15.8490 41.4518 15.8495 41.4521 15.8495 41.4521 15.8490 41.4518 15.8490</gml:posList>
              </gml:LinearRing></gml:interior>
            </gml:PolygonPatch></gml:patches></gml:Surface>
          </gml:surfaceMember>
        </gml:MultiSurface>
      </CP:geometry>
      <CP:nationalCadastralReference>D643_001500042</CP:nationalCadastralReference>
      <CP:label>42</CP:label>
      <CP:areaValue uom="m2">44815</CP:areaValue>
    </CP:CadastralParcel>
  </wfs:member>
  <wfs:member>
    <CP:CadastralParcel gml:id="CP.2">
      <CP:geometry>
        <gml:Polygon srsName="EPSG:4326">
          <gml:exterior><gml:LinearRing>
            <gml:posList>15.8530 41.4514 15.8550 41.4514 15.8550 41.4526 15.8530 41.4526</gml:posList>
          </gml:LinearRing></gml:exterior>
        </gml:Polygon>
      </CP:geometry>
      <CP:nationalCadastralReference>D643_001500043</CP:nationalCadastralReference>
      <CP:label>43</CP:label>
    </CP:CadastralParcel>
  </wfs:member>
</wfs:FeatureCollection>"#;

    #[test]
    fn parses_inspire_gml_both_surface_flavors() {
        let feats = parse_cadastral_gml(SAMPLE).expect("parse");
        assert_eq!(feats.len(), 2);

        let a = &feats[0];
        assert_eq!(a.reference.as_deref(), Some("D643_001500042"));
        assert_eq!(a.label.as_deref(), Some("42"));
        assert_eq!(a.area_m2, Some(44815.0));
        assert_eq!(a.polygons.len(), 1);
        assert_eq!(a.polygons[0].len(), 2); // exterior + hole
                                            // lat,lon in the document → lon,lat in GeoJSON
        assert_eq!(a.polygons[0][0][0], [15.8478, 41.4514]);

        let b = &feats[1];
        assert_eq!(b.polygons.len(), 1);
        assert_eq!(b.polygons[0].len(), 1);
        // lon,lat in the document stays lon,lat; unclosed ring gets closed
        assert_eq!(b.polygons[0][0][0], [15.8530, 41.4514]);
        assert_eq!(b.polygons[0][0].first(), b.polygons[0][0].last());
        assert_eq!(b.polygons[0][0].len(), 5);
    }

    #[test]
    fn geometry_json_shapes() {
        let feats = parse_cadastral_gml(SAMPLE).unwrap();
        let g = feats[0].geometry_geojson();
        assert_eq!(g["type"], "Polygon");
        let two = CadastralFeature {
            polygons: feats.iter().flat_map(|f| f.polygons.clone()).collect(),
            ..Default::default()
        };
        assert_eq!(two.geometry_geojson()["type"], "MultiPolygon");
    }

    /// Trimmed from a REAL AdE response (2026-08): MapServer emits `CP:msGeometry`,
    /// UPPERCASE property names and no areaValue. This casing must keep parsing.
    const ADE_SAMPLE: &str = r#"<?xml version='1.0' encoding="UTF-8" ?>
<wfs:FeatureCollection xmlns:CP="http://mapserver.gis.umn.edu/mapserver"
   xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:wfs="http://www.opengis.net/wfs/2.0"
   timeStamp="2026-08-01T13:00:41" numberMatched="unknown" numberReturned="1">
    <wfs:member>
      <CP:CadastralParcel gml:id="CadastralParcel.IT.AGE.PLA.E885_014100.119">
        <CP:msGeometry>
          <gml:MultiSurface srsName="urn:ogc:def:crs:EPSG::6706">
            <gml:surfaceMember>
              <gml:Polygon gml:id="P.1">
                <gml:exterior><gml:LinearRing>
                  <gml:posList srsDimension="2">41.44745002 15.84647491 41.44741207 15.84649692 41.44955644 15.85421308 41.44745002 15.84647491 </gml:posList>
                </gml:LinearRing></gml:exterior>
              </gml:Polygon>
            </gml:surfaceMember>
          </gml:MultiSurface>
        </CP:msGeometry>
        <CP:INSPIREID_LOCALID>IT.AGE.PLA.E885_014100.119</CP:INSPIREID_LOCALID>
        <CP:LABEL>119</CP:LABEL>
        <CP:NATIONALCADASTRALREFERENCE>E885_014100.119</CP:NATIONALCADASTRALREFERENCE>
        <CP:ADMINISTRATIVEUNIT>E885</CP:ADMINISTRATIVEUNIT>
      </CP:CadastralParcel>
    </wfs:member>
</wfs:FeatureCollection>"#;

    #[test]
    fn parses_real_ade_mapserver_casing() {
        let feats = parse_cadastral_gml(ADE_SAMPLE).expect("parse");
        assert_eq!(feats.len(), 1);
        let f = &feats[0];
        assert_eq!(f.reference.as_deref(), Some("E885_014100.119"));
        assert_eq!(f.label.as_deref(), Some("119"));
        assert_eq!(f.area_m2, None);
        // lat,lon in the document → lon,lat in GeoJSON
        assert_eq!(f.polygons[0][0][0], [15.84647491, 41.44745002]);
    }

    #[test]
    fn exception_report_is_an_error_not_empty() {
        let doc = r#"<?xml version="1.0" encoding="ISO-8859-1" standalone="no"?>
<ServiceExceptionReport version="1.1.1"><ServiceException code="InvalidFormat"><![CDATA[Richiesta non valida ]]></ServiceException></ServiceExceptionReport>"#;
        let err = parse_cadastral_gml(doc).expect_err("must not be an empty success");
        assert!(err.contains("Richiesta non valida"), "got: {err}");
    }

    #[test]
    fn rejects_bad_bboxes() {
        assert!(parse_bbox("not,a,bbox").is_err());
        assert!(parse_bbox("15.85,41.45,15.84,41.46").is_err()); // w >= e
        assert!(parse_bbox("15.0,41.0,15.5,41.5").is_err()); // too wide
        assert!(parse_bbox("2.0,48.8,2.02,48.82").is_err()); // Paris — out of coverage
        let ok = parse_bbox("15.845,41.449,15.856,41.454").unwrap();
        assert_eq!(ok, [15.845, 41.449, 15.856, 41.454]);
    }

    #[test]
    fn poslist_degenerate_cases() {
        assert!(parse_pos_list("41.0 15.0 41.1 15.1").is_none()); // 2 points
        assert!(parse_pos_list("41.0 15.0 41.1").is_none()); // odd count
        assert!(parse_pos_list("").is_none());
    }
}
