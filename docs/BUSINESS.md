# Arvo — business model

> **Status (2026-08-01): adopted.** Canonical description of how Arvo makes money — and, just as
> deliberately, how it never will. The tiers below are *commercial* packaging; the engineering
> capability tiers (0/A/B/C) are defined in [agronomic-platform-spec.md](../agronomic-platform-spec.md)
> §1. What is actually built: [PHASE0.md](PHASE0.md). The farmer-ready iOS revamp:
> [UX-REVAMP.md](UX-REVAMP.md). Per-plant tier design: [PHASE-PLANT.md](PHASE-PLANT.md).

## 1. Thesis — generosity is structurally cheap

The inputs of the core product cost approximately nothing, and the stack was chosen that way:

| What the core product consumes | Source | Marginal cost |
|--------------------------------|--------|---------------|
| Sentinel-2 L2A imagery | Earth Search STAC (AWS open data) | €0 — free, no key |
| Weather: forecast, archive, ET₀ | Open-Meteo | €0 — free, no key |
| Parcel-clipped pixel compute (NDVI & co.) | own worker, COGs over `/vsicurl/` | cents per field-season |
| Storage: series rows, alerts, observations | PostGIS | cents |

NFR-COST-011 already mandates tracking the marginal cloud cost per parcel-season and keeping it
compatible with SMB pricing; the free tier is that requirement taken seriously. The expensive
things — drone flights and SfM compute ([PHASE-PLANT.md](PHASE-PLANT.md)), Field Gateway hardware
(spec §13), licensed human agronomists (NFR-CMP-030), compliance paperwork — are exactly where
farmers' willingness to pay is real, because each one replaces a cost they already bear today.

**Charge there. Never at the data layer.** A farmer's own field data, and the safety alerts derived
from it, are never the product.

## 2. Tiers

| Tier | Price | For | Includes |
|------|-------|-----|----------|
| **Arvo Gratis** | €0 — forever, not a trial | every farm | unlimited fields (fair use), Arvo Score, grouped alerts **with push**, weather + frost/heat/spray advisories, offline scouting, cadastre onboarding, 12 months of history, full export |
| **Arvo Pro** | ~€99/anno per azienda | farms that manage by data | everything in Gratis, plus: full index raster layers, multi-year history, GeoTIFF/PDF season reports, multi-user, priority imagery refresh, the per-plant module when it ships, and — future — Quaderno di Campagna (§3) |
| **Arvo Agronomo** | ~€490/anno per studio | advisory studios, co-ops | multi-farm console, client management, prescription authoring & sign-off, white-label reports; Pro free for the agronomist's own use |
| **Hardware & heavy compute** | transparent cost+margin | Tier A / per-plant adopters | Field Gateway at BoM + margin (€80–300, spec §13) + ~€15/mese closed-loop irrigation; drone per-plant analysis per flight |

All three software tiers run on Tier-0 capability (spec §6); the fourth column is where the
capability tiers A/B and the per-plant layer attach commercially.

**Arvo Gratis** — free forever is a strategy, not charity: the marginal cost rounds to cents (§1)
and a genuinely complete free product is the growth engine (§4). "Complete" is the operative word —
Gratis keeps push alerts and offline scouting because a free tier that goes silent the night of a
frost is not decision support, it's a brochure. Twelve months of history covers a full season
cycle; older data is never deleted — it moves behind Pro and stays exportable (§5, commitment 3).

**Arvo Pro** — sells depth, not access: raster index layers on the map (the XYZ tile / GeoTIFF
pipeline), season-over-season comparison, formal outputs (GeoTIFF/PDF season reports), team
accounts, priority imagery refresh. When the per-plant module ships
([PHASE-PLANT.md](PHASE-PLANT.md)), its results surface in Pro; the drone flights that feed it are
billed separately (below). The Quaderno di Campagna (§3) ships as the first Pro-exclusive module.

**Arvo Agronomo** — the agronomist is the distribution engine (§4), so the tier is built around
their workflow: a multi-farm console on the existing web portal (client switching, portfolio
dashboard, cross-farm alert triage), client management, and prescription authoring with sign-off —
implementing the spec's liability seam (FR-B-CONF, NFR-CMP-030: prescriptive advice is attributable
to a licensed professional; the platform itself stays decision-support). White-label season reports
carry the studio's identity. Pro is included free for the agronomist's own use — they must love the
product they recommend.

**Hardware & heavy compute** — the Field Gateway is sold at transparent cost plus margin against
the spec's BoM targets (§13: ~€40–80 mains Variant E, ≤€300 solar Variant S), with ~€15/mese for
the closed-loop irrigation service, priced against measured water savings — the water balance is
already computed in Tier 0, and flow feedback closes the loop (FR-A-012). Drone per-plant analysis is billed
per flight, because SfM compute is the one genuinely expensive workload in the system; no
subscription required to fly once.

## 3. Next: Quaderno di Campagna

**Not built in this iteration — decision 2026-08-01.** The UX revamp ships only a "coming soon"
line in settings ([UX-REVAMP.md](UX-REVAMP.md) §Non-goals: no screens, no endpoints). This section
exists so the next iteration starts from a written rationale instead of a remembered one.

Why it is the monetization wedge:

- **Legal obligation, universal.** The *registro dei trattamenti* is mandatory for every Italian
  farm that applies plant-protection products. Not a nice-to-have — an inspection item.
- **Paper incumbent.** Most small farms still keep it on paper, reconstructed the evening before a
  CAA visit or an inspection. The competitor is a notebook, not another SaaS.
- **Recurring by construction.** Every treatment is an entry; a season is dozens. It creates weekly
  active use in exactly the population that otherwise opens the app when something is wrong.
- **Composes with what's shipped.** Scouting notes → treatment records → signed compliance PDF
  reuses the offline outbox, photo capture, and the report pipeline; later, treatment history feeds
  ISO-XML prescriptions for Tier B (spec §8).
- **Monetizes time saved — not data hostage-taking.** The farmer pays because filing takes minutes
  instead of an evening, which is precisely the "measurable value" commitment 5 (§5) allows
  charging for.

Scope sketch for the next iteration (a starting point, not a spec):

- treatments registry: product, dose, parcel, date, operator, equipment
- link to the Italian PPP product database for label data
- PHI / re-entry warnings (tempi di carenza / rientro) surfaced in scouting and harvest planning
- inspection-ready PDF export — the registro itself, signed
- PAC eco-scheme documentation support

**It ships as the first Pro-exclusive module.** Safety alerts and the data layer stay free (§5).

## 4. Go-to-market — mass adoption mechanics

- **Agronomists, co-ops, consorzi are force multipliers.** One agronomist advises 30–200 farms;
  one €490 studio seat deploys Arvo across a portfolio. This is why Agronomo exists and why it
  includes free Pro — the advisor is both customer and channel.
- **Cadastre onboarding is the live demo.** With the client's fascicolo aziendale in hand, an
  advisor sets up a whole farm in minutes by tapping parcels on the cadastral overlay
  (FR-0-010b) — inside a single client visit, no GIS skills, no boundary drawing.
- **CAA offices at PAC-filing season.** The Centri di Assistenza Agricola already hold the
  fascicolo and see every farmer at least once a year — the natural moment and place to onboard.
- **Crop consortia** (consorzi di tutela, cantine sociali, OP): one agreement reaches many members,
  and aggregated benchmarks grow more valuable with member density — strictly opt-in, with the
  benchmark returned free to contributors (§5, commitment 2).
- **Word-of-mouth economics.** A genuinely complete free tier *is* the marketing budget: a farmer
  who got a real frost warning for free tells the whole bar. Customer-acquisition cost approaches
  zero exactly where the product is good enough to deserve it.

## 5. Non-enshittification constitution

Written down early precisely so it binds later decisions — including ours, under revenue pressure.
Any change to this list must be public, versioned in this file, and apply only forward.

1. **The free tier is permanent.** Safety alerts are never paywalled.
2. **No ads, ever. No data resale, ever.** Aggregated benchmarks are opt-in, and the benchmark is
   returned free to those who contribute to it.
3. **Export everything, always. Deletion means deletion.**
4. **Grandfathering: price changes apply to new capabilities only.** What you already have never
   gets more expensive or smaller.
5. **We charge only where we incur real cost or create measurable value** — never for access to
   your own data.
6. **Open API on paid tiers. No lock-in.** Leaving must be easy; staying must be earned.

## 6. Risks & guardrails

| Risk | Guardrail |
|------|-----------|
| Free-tier cost creep | NFR-COST-011 made operational: a cost dashboard tracking marginal € per parcel-season from day one. Fair-use levers act on compute cadence (imagery refresh frequency for enormous free portfolios), never on data access or safety alerts. |
| iOS-first alienates Android farmers | Deliberate sequencing: one polished launch platform (the UX revamp is iOS-first) beats two mediocre ones. The web portal is the interim answer on any device. **Android fast-follow within a quarter** — Expo makes it an EAS build configuration, not a rewrite. |
| Pricing experiments erode trust | Experiments run only on new capabilities and new signups; commitment 4 (grandfathering) is the hard floor. Existing entitlements are never A/B-tested, repriced, or shrunk. |
| Agronomo tier under-adopts | Free Pro for own use plus the cadastre-onboarding demo reduce trial cost to one client visit; if studios stall, direct-to-farm Pro still carries the model. |
| Quaderno compliance drift | Build the registro against current requirements with a licensed agronomist advising; keep the PDF format versioned and inspection-driven (§3). |

---

Cross-references: capability tiers and FGW BoM — [agronomic-platform-spec.md](../agronomic-platform-spec.md)
(§1, §13, NFR-COST-010/011, NFR-CMP-030) · shipped scope — [PHASE0.md](PHASE0.md) · UX revamp
contract — [UX-REVAMP.md](UX-REVAMP.md) · per-plant design — [PHASE-PLANT.md](PHASE-PLANT.md).
