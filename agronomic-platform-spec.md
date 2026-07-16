# Agronomic Monitoring & Actuation Platform — Technical Specification

**Version:** 0.1 (draft) · **Status:** for review · **Date:** 2026-07-16
**Scope:** Software platform (web portal + mobile app + backend) and a low-cost field gateway for hardware integration.
**Author:** —

---

## 1. Purpose and scope

This document specifies functional (FR) and non-functional (NFR) requirements for a precision-agronomy platform targeting SMB farms, and for the low-cost field gateway ("FGW") that bridges field hardware to the platform.

The system is delivered in four capability tiers. Each tier is independently shippable and strictly additive; a farm can operate at any tier without the tiers above it.

| Tier | Name | Delivers | Hardware dependency | Legal exposure |
|------|------|----------|---------------------|----------------|
| **0** | Platform-only | Satellite + weather + scouting + insights, portal & app | None (SaaS only) | Low (decision support) |
| **A** | Owned actuation | Closed-loop irrigation/fertigation via FGW + your sensors/valves | FGW + LoRaWAN nodes | Low–medium (reversible acts) |
| **B** | Machinery integration | Variable-rate prescriptions to ISOBUS/OEM machines via agrirouter | Customer's ISOBUS kit | Medium (agronomic prescription) |
| **C** | Robot integration | Mission dispatch to customer-owned autonomous robots | Customer's robot + vendor API | High / gated (esp. spraying) |

**Tier 0 is the immediate build target** and carries no hardware or actuation risk. Tiers A–C attach to it through a single **Actuator Abstraction Layer** (§5.3).

### 1.1 Out of scope (this release)
- Building or manufacturing robots or field machinery (integration only).
- Autonomous aerial application of plant-protection products (blocked by law; see NFR-CMP-040).
- Full farm-accounting / ERP, traceability blockchain, livestock.
- Reselling €50k+ robots as a hardware channel (opportunistic only; not specified here).

---

## 2. Definitions

| Term | Meaning |
|------|---------|
| **FGW** | Field Gateway: on-farm edge device (concentrator + edge controller). |
| **Node** | LoRaWAN end device: sensor and/or single-zone actuator. |
| **LNS** | LoRaWAN Network Server (e.g. ChirpStack). |
| **Intervention** | Canonical internal object representing a corrective action (§5.3). |
| **Prescription** | Spatially-variable rate map (ISO-XML) for machinery. |
| **agrirouter** | Manufacturer-independent data *transport* platform (DKE-Data). Moves ISO-XML jobs/telemetry; does **not** provide real-time control. |
| **ADAPT** | AgGateway open-source toolkit for translating proprietary field-data formats. |
| **TC** | ISOBUS Task Controller (ISO 11783-10). |
| **DSS** | Decision Support System (indicators, not binding prescriptions). |
| **PPP** | Plant Protection Product (pesticide). |
| **ET0** | Reference evapotranspiration (Penman-Monteith). |
| **GDD** | Growing Degree Days. |
| **Reversible action** | Action whose effect can be undone or naturally decays (e.g. irrigation). Contrast irreversible (chemical application). |

**Priority (MoSCoW):** **M** Must (in-tier MVP) · **S** Should · **C** Could · **W** Won't (this release).

---

## 3. Actors

- **Farmer / grower** — owns fields; consumes insights; approves/executes actions.
- **Agronomist** — licensed advisor; authors/signs prescriptions; the liability-bearing human-in-the-loop for Tier B/C actions.
- **Field operator** — performs scouting, drone flights, installs hardware.
- **Org admin** — manages tenant, users, billing, connectors.
- **Platform operator (you)** — SRE/support; fleet and pipeline operations.
- **External systems** — Copernicus/Sentinel Hub, weather services, agrirouter, OEM clouds (e.g. John Deere Operations Center), robot vendor clouds, LNS.

---

## 4. System context

```
                +-------------------- Cloud Platform --------------------+
 Sentinel-2 --->|  Imagery pipeline   Weather/agro   Agronomy engine     |
 Weather    --->|  Field & tenant mgmt  Alerting  Reporting  API/GraphQL  |
                |  Device mgmt   Actuator Abstraction Layer   Workflow    |
                +---^-------------------------^-----------------------^---+
                    | MQTT/TLS                 | agrirouter API        | vendor API
                    |                          |                       |
              +-----+------+            +-------+-------+       +-------+------+
              | Field GW    |            | ISOBUS / OEM  |       | Robot vendor |
              | (edge ctrl, |            | machinery     |       | cloud/fleet  |
              |  LNS, S&F)  |            | (Tier B)      |       | (Tier C)     |
              +--+-------+--+            +---------------+       +--------------+
                 |LoRaWAN|
           +-----+--+ +--+-----+
           | Sensor | | Actuator| (valves, dosing pumps)  <-- Tier A
           | nodes  | | nodes   |
           +--------+ +---------+

  Web portal + Mobile app (offline-first) --- HTTPS/GraphQL --> Cloud Platform
```

---

## 5. Architecture overview

### 5.1 Logical components
1. **Ingestion**: satellite (STAC/openEO), weather/agrometeo, device telemetry (MQTT), machinery/robot telemetry (agrirouter/vendor).
2. **Field & tenant service**: orgs, farms, parcels (geometry), crops, seasons, RBAC.
3. **Imagery pipeline**: tiling, cloud masking, index computation, management-zone delineation, time series.
4. **Agronomy engine**: anomaly detection, phenology (GDD), water balance (ET0), alert rules, DSS insights.
5. **Actuator Abstraction Layer (AAL)** (§5.3): canonical Interventions → adapters.
6. **Workflow/orchestration**: durable, long-running task lifecycle and reconciliation (recommend Temporal).
7. **API layer**: GraphQL + REST + webhooks; OGC endpoints (WMTS/STAC) for imagery.
8. **Delivery**: web portal, mobile app, notifications.
9. **Cross-cutting**: identity/OIDC, secrets vault, observability, audit.

### 5.2 Reference implementation (recommended, non-binding)
Backend services in Rust and/or Python; PostgreSQL + PostGIS; object store (S3-compatible) for rasters; ChirpStack as LNS; MQTT broker (EMQX/Mosquitto); Temporal for workflows; Qdrant (optional) for agronomic knowledge retrieval; Authentik (OIDC) for identity; OpenBao for secrets; Grafana LGTM + OpenTelemetry for observability; Caddy for ingress; OpenTofu + Proxmox for infra; GitOps via Gitea. EU-region hosting.

### 5.3 Actuator Abstraction Layer (the core design)
A single canonical **Intervention** object is produced by the agronomy engine and consumed by pluggable adapters. Adapters have deliberately different fidelity:

- **DirectActuatorDriver** (Tier A): real-time command to owned actuators via FGW. Closed loop.
- **JobExporter** (Tier B): asynchronous — emits ISO-XML prescription to agrirouter/OEM cloud; reconciles as-applied telemetry. Human or machine executes.
- **RobotMissionAdapter** (Tier C): per-vendor mission dispatch where a partnership/API exists.
- **ManualFallback** (all tiers): renders a task list / embeds vendor UI when no programmatic path exists.

Every Intervention passes a **reversibility-keyed confirmation gate** (FR-X-CONF): reversible low-risk actions may auto-execute within bounds; irreversible/regulated actions require explicit human approval.

---

## 6. Functional requirements — Tier 0 (platform-only, build now)

### 6.1 Tenancy, identity, access
- **FR-0-001 (M):** The system shall support multi-tenant isolation (organization → farm → field), with no cross-tenant data access.
- **FR-0-002 (M):** The system shall authenticate users via OIDC and enforce role-based access control with at least the roles in §3.
- **FR-0-003 (S):** The system shall allow an org to invite an external agronomist with scoped, revocable access to selected farms.
- **FR-0-004 (M):** The system shall maintain an append-only audit log of security- and action-relevant events.

### 6.2 Field, crop, season management
- **FR-0-010 (M):** The system shall let users create parcels by drawing on a map or importing GeoJSON, KML, Shapefile, or ISO-XML field boundaries.
- **FR-0-011 (M):** The system shall store parcel geometry in a projected/geographic CRS and compute area, centroid, and bounding box.
- **FR-0-012 (M):** The system shall associate each parcel with a crop, variety (optional), planting date, and season.
- **FR-0-013 (S):** The system shall import master data (farms, fields, boundaries, crops) from agrirouter to bootstrap Tier B customers without manual entry.
- **FR-0-014 (C):** The system shall support parcel sub-zoning (management zones) derived from imagery clustering.

### 6.3 Satellite imagery and indices
- **FR-0-020 (M):** The system shall ingest Sentinel-2 L2A scenes for all active parcels via a STAC/openEO source.
- **FR-0-021 (M):** The system shall apply cloud/shadow masking (e.g. scene classification / s2cloudless) and reject or flag scenes exceeding a configurable cloud threshold over the parcel.
- **FR-0-022 (M):** The system shall compute per-parcel vegetation indices: NDVI, NDRE, GNDVI, NDMI, SAVI (index set extensible).
- **FR-0-023 (M):** The system shall maintain a per-parcel, per-index time series with cloud-quality metadata.
- **FR-0-024 (S):** The system shall compute per-parcel statistics (mean, median, p10/p90, intra-field variance) per acquisition.
- **FR-0-025 (S):** The system shall support an optional higher-resolution paid source (e.g. Planet) as a premium per-parcel option.
- **FR-0-026 (C):** The system shall estimate surface soil moisture from optical/SWIR (e.g. OPTRAM) where bands permit, flagged as modelled (not measured).
- **FR-0-027 (M):** The system shall expose imagery to clients as web tiles (WMTS/XYZ) and downloadable GeoTIFF.

### 6.4 Weather and agronomic models
- **FR-0-030 (M):** The system shall ingest forecast and observed weather per parcel location (temperature, precipitation, humidity, wind, radiation).
- **FR-0-031 (S):** The system shall compute GDD-based phenology estimates per crop where a model exists.
- **FR-0-032 (S):** The system shall compute reference evapotranspiration (ET0, Penman-Monteith) and a simple crop water balance per parcel (input to Tier A).
- **FR-0-033 (S):** The system shall generate weather-driven advisories (frost risk, heat stress, suitable spray/field-work windows).

### 6.5 Scouting and observations (mobile-first)
- **FR-0-040 (M):** The mobile app shall let users record geotagged, timestamped field observations with photos and free text/tags.
- **FR-0-041 (M):** The mobile app shall function offline and synchronise observations on reconnect without data loss.
- **FR-0-042 (S):** The system shall overlay scouting points on the current index map and let users pin observations to anomalies.
- **FR-0-043 (C):** The system shall provide on-device or server-side image-based pest/disease suggestions, clearly labelled advisory-only.

### 6.6 Insights, anomalies, alerting
- **FR-0-050 (M):** The system shall detect per-parcel anomalies in index time series (abrupt drop, divergence from field mean or from historical baseline for the same phenological window).
- **FR-0-051 (M):** The system shall raise alerts (in-app, push, email) with severity, affected zone, and a plain-language explanation.
- **FR-0-052 (M):** All generated guidance shall be framed as decision support (indicators and options), never as a binding agronomic or PPP prescription (see NFR-CMP-030).
- **FR-0-053 (S):** The system shall let users acknowledge, snooze, assign, or dismiss alerts, with state retained.
- **FR-0-054 (C):** The system shall allow user-defined alert rules over any ingested variable.

### 6.7 Reporting and export
- **FR-0-060 (M):** The system shall produce per-parcel and per-season reports (PDF) summarising index trends, alerts, scouting, and interventions.
- **FR-0-061 (S):** The system shall export data via API and files (GeoTIFF, GeoJSON, CSV; ISO-XML reserved for Tier B).
- **FR-0-062 (C):** The system shall generate subsidy-support documentation packages (activity logs suitable for 4.0 / PSR reporting).

### 6.8 Portal and app (delivery)
- **FR-0-070 (M):** The system shall provide a responsive web portal for management, mapping, and analysis.
- **FR-0-071 (M):** The system shall provide iOS and Android apps sharing the backend, optimised for field use.
- **FR-0-072 (M):** The UI shall be localised, Italian first, with an i18n framework for further locales and units.

---

## 7. Functional requirements — Tier A (owned actuation + Field Gateway)

### 7.1 Device and fleet management
- **FR-A-001 (M):** The system shall register FGWs and nodes with unique identity and bind them to a farm/parcel.
- **FR-A-002 (M):** The system shall ingest node telemetry (soil moisture, temperature, EC, flow, pressure, battery) via the LNS → MQTT path.
- **FR-A-003 (M):** The system shall decode LoRaWAN payloads via versioned codecs (e.g. published device-repository decoders).
- **FR-A-004 (M):** The system shall display per-device health (last-seen, RSSI/SNR, battery, firmware) and raise offline/low-battery alerts.
- **FR-A-005 (S):** The system shall support remote configuration of node reporting cadence within duty-cycle limits.

### 7.2 Closed-loop irrigation / fertigation
- **FR-A-010 (M):** The system shall let an authorised user define irrigation policies per zone (thresholds on soil moisture and/or ET-based water balance, schedules, max volume/day, max runtime).
- **FR-A-011 (M):** The system shall issue actuation Interventions to open/close valves and run dosing pumps through the DirectActuatorDriver adapter.
- **FR-A-012 (M):** The system shall confirm actuation success using feedback (flow/pressure/valve state) and flag actuation faults.
- **FR-A-013 (M):** The FGW shall execute the active control policy autonomously when disconnected from the cloud (see NFR-AVL-020).
- **FR-A-014 (M):** The system shall enforce safety bounds locally at the FGW: max runtime, max daily volume, rain/flow-fault interlocks, safe-state on sensor loss.
- **FR-A-015 (S):** The system shall support fertigation dosing with concentration/EC limits and interlock to the irrigation loop.

### 7.3 Confirmation gate and audit
- **FR-A-CONF (M):** Reversible actions (irrigation) may auto-execute within configured bounds; irreversible or over-threshold actions (e.g. fertigation beyond a set dose) shall require explicit human approval before execution.
- **FR-A-020 (M):** The system shall record every Intervention (requested, approved-by, dispatched, executed, confirmed/failed, as-applied) in an immutable trail.

### 7.4 Field Gateway (FGW) functional requirements
- **FR-GW-001 (M):** The FGW shall receive LoRaWAN uplinks from nodes and forward them to the cloud (via embedded or upstream LNS).
- **FR-GW-002 (M):** The FGW shall run a local rules/control engine capable of closing sense→act loops without cloud connectivity.
- **FR-GW-003 (M):** The FGW shall drive local actuator outputs (relays/latching-valve drivers) and read local feedback inputs (flow/pressure/valve state).
- **FR-GW-004 (M):** The FGW shall buffer telemetry and Intervention records during backhaul outage and forward on reconnect (store-and-forward).
- **FR-GW-005 (M):** The FGW shall authenticate to the cloud with mutual TLS and reject unsigned control payloads.
- **FR-GW-006 (M):** The FGW shall support signed over-the-air updates with A/B partitions and automatic rollback on failed health check.
- **FR-GW-007 (S):** The FGW shall expose local health metrics (Prometheus/OTLP) and push them when connected.
- **FR-GW-008 (S):** The FGW shall operate off-grid on solar + battery for the power-autonomy target (NFR-PWR-010).
- **FR-GW-009 (C):** The FGW shall store device identity/keys in a secure element (e.g. ATECC608).

---

## 8. Functional requirements — Tier B (ISOBUS / OEM machinery via agrirouter)

- **FR-B-001 (M):** The system shall generate variable-rate prescriptions from management zones and agronomic logic, exported as ISO-XML (ISOBUS TC compatible).
- **FR-B-002 (M):** The system shall onboard to agrirouter and send prescriptions / receive as-applied and telemetry through it, treating the exchange as asynchronous job handoff (not real-time control).
- **FR-B-003 (S):** The system shall connect OEM clouds reachable via agrirouter (e.g. John Deere Operations Center) for prescription push and as-applied pull.
- **FR-B-004 (M):** The system shall use a format-translation layer (e.g. ADAPT) to normalise proprietary field-data formats to/from the canonical model.
- **FR-B-005 (M):** The system shall track task lifecycle (dispatched → executed → reconciled) and surface discrepancies between prescribed and as-applied.
- **FR-B-CONF (M):** A prescription shall require sign-off by a licensed agronomist (or explicit farmer override with recorded liability acknowledgement) before dispatch.
- **FR-B-006 (C):** The system shall provide a manual fallback (downloadable ISO-XML / USB workflow) for machines not reachable via agrirouter.

---

## 9. Functional requirements — Tier C (autonomous robots — gated)

- **FR-C-001 (S):** The system shall define per-vendor RobotMissionAdapters behind the AAL, activated only where a vendor API/partnership exists.
- **FR-C-002 (S):** The system shall translate an Intervention into a vendor mission (zone, task, constraints) and dispatch it.
- **FR-C-003 (S):** The system shall ingest robot fleet status and mission results and reconcile them as as-applied.
- **FR-C-004 (M):** The system shall treat autonomous chemical application as disabled by default and gated behind a compliance feature flag (NFR-CMP-040).
- **FR-C-CONF (M):** All Tier C actions require explicit human approval; no autonomous chemical mission may be dispatched while the compliance gate is closed.
- **FR-C-005 (W):** Real-time teleoperation of third-party robots (out of scope; no standard exists).

---

## 10. Non-functional requirements

### 10.1 Performance & scalability
- **NFR-PERF-010 (M):** Read API p95 latency < 300 ms; write p95 < 800 ms (excluding async processing jobs), under nominal load.
- **NFR-PERF-011 (M):** New Sentinel-2 acquisitions shall be processed to per-parcel indices within 24 h of source availability; per-parcel index computation < 5 min after tile ingest.
- **NFR-PERF-012 (M):** Telemetry ingestion shall scale to ≥ 10,000 uplinks/min platform-wide; a single FGW shall support ≥ 100 nodes.
- **NFR-PERF-013 (S):** The system shall scale horizontally to 10,000 parcels / 1,000 tenants without architectural change.

### 10.2 Availability & resilience
- **NFR-AVL-010 (M):** Cloud platform target availability ≥ 99.5% (initial), excluding scheduled maintenance.
- **NFR-AVL-020 (M):** Safety-critical field control (Tier A local loops) shall have **zero** dependency on cloud availability; the FGW shall maintain autonomous control and safe-state behaviour during cloud/backhaul outage.
- **NFR-AVL-021 (M):** The FGW store-and-forward buffer shall retain ≥ 7 days of telemetry and Intervention records without loss.
- **NFR-AVL-022 (S):** Cloud commands and edge actions shall be idempotent and acknowledged; duplicate/replayed commands shall not cause double actuation.

### 10.3 Data integrity & durability
- **NFR-DAT-010 (M):** Ingested telemetry and Intervention records shall be durably persisted with no silent loss; ingestion shall be idempotent on device-side sequence numbers.
- **NFR-DAT-011 (M):** The audit/Intervention trail shall be append-only and tamper-evident, retained ≥ 24 months.
- **NFR-DAT-012 (S):** Raster and time-series data shall be versioned and reproducible (source scene → derived product traceable).

### 10.4 Security
- **NFR-SEC-010 (M):** All external transport shall use TLS 1.2+; FGW↔cloud shall use mutual TLS.
- **NFR-SEC-011 (M):** LoRaWAN nodes shall use OTAA with per-device keys; keys shall be stored in a vault, never in source or images.
- **NFR-SEC-012 (M):** OTA images and control payloads shall be cryptographically signed; unsigned artifacts shall be rejected.
- **NFR-SEC-013 (M):** Tenant isolation shall be enforced at the data layer (row-level or per-tenant schema) and verified by automated tests.
- **NFR-SEC-014 (S):** Secrets management, key rotation, and least-privilege service identities shall be standard.

### 10.5 Compliance, legal & safety
- **NFR-CMP-010 (M):** The system shall host and process EU personal/business data in the EU and comply with GDPR (data subject rights, DPA with sub-processors).
- **NFR-CMP-020 (M):** Data sovereignty shall be preserved in machinery exchange (agrirouter as transport only; the platform shall not repurpose customer machine data without consent).
- **NFR-CMP-030 (M):** Prescriptive agronomic advice (fertilisation, PPP) shall be attributable to a licensed agronomist; the platform's own outputs shall be presented as decision support. (Confirm professional-liability specifics with counsel.)
- **NFR-CMP-040 (M):** Autonomous aerial/robotic application of PPPs shall remain disabled until: (a) the applicable Italian implementing decree is in force, (b) the EU exemption framework (Dir. 2009/128/EC as amended, delegated acts on eligible UAS) applies, and (c) the specific product is authorised for that application under Reg. 1107/2009. Compliance state shall be an explicit, auditable feature flag.
- **NFR-CMP-050 (S):** Commercial drone-scouting operations shall be operable under EASA Open/Specific-category requirements (operator registration, pilot competency, insurance) — tracked operationally, outside the software.

### 10.6 Interoperability
- **NFR-INT-010 (M):** Geospatial I/O shall use open formats (GeoJSON, GeoTIFF, ISO-XML) and OGC services (WMTS/STAC) where applicable.
- **NFR-INT-011 (M):** Machinery integration shall use ISOBUS TC / ISO-XML via agrirouter; format translation via ADAPT.
- **NFR-INT-012 (M):** Device connectivity shall use LoRaWAN (EU868) + MQTT; the LNS shall be self-hostable.
- **NFR-INT-013 (S):** The AAL adapter interface shall be a stable, versioned contract enabling third-party adapters without core changes.

### 10.7 Observability & operability
- **NFR-OBS-010 (M):** Services and FGWs shall emit metrics, logs, and traces via OpenTelemetry to a central observability stack.
- **NFR-OBS-011 (M):** Fleet dashboards shall surface device health, ingestion lag, pipeline backlog, and control-loop status.
- **NFR-OBS-012 (S):** Alerting shall exist on data-freshness SLOs (e.g. imagery stale, gateway offline, ingestion lag).

### 10.8 Cost
- **NFR-COST-010 (M):** FGW hardware BoM shall target ≤ €300 (off-grid solar variant) and ≤ €80 (mains/Wi-Fi edge-controller variant). *(2026 EU ballpark; verify.)*
- **NFR-COST-011 (S):** Marginal cloud cost per parcel-season (satellite + storage + compute) shall be tracked and kept economically compatible with SMB pricing.

### 10.9 Maintainability, deployability, portability
- **NFR-MNT-010 (M):** All infrastructure shall be reproducible as code (IaC) and deployed via GitOps; the platform shall be self-hostable.
- **NFR-MNT-011 (S):** FGW images shall be reproducible and immutable (e.g. Buildroot/Yocto or NixOS), with declarative configuration.
- **NFR-MNT-012 (M):** Public APIs shall be versioned; breaking changes shall follow a deprecation policy.
- **NFR-PORT-010 (M):** The mobile app shall be fully usable offline for field workflows and reconcile on reconnect.

---

## 11. Core data model (entities)

- **Organization** 1—* **Farm** 1—* **Parcel** (geometry, crop, season).
- **Parcel** 1—* **ManagementZone**; 1—* **IndexObservation** (index, value, scene id, cloud%, timestamp).
- **Scene** (source, tile, acquisition, quality) — derives IndexObservation (lineage).
- **Device** (FGW | Node) —bound-to→ Parcel; 1—* **Telemetry** (metric, value, ts, seq).
- **Policy** (irrigation/fertigation config) —applies-to→ Zone/Parcel.
- **Intervention** (type, target zone, params, reversibility, state machine, approvals, as-applied) — the AAL spine.
- **Prescription** (ISO-XML ref, agronomist sign-off) — a Tier B Intervention specialization.
- **Alert** (severity, source, zone, state).
- **User / Role / Membership** (RBAC).
- **AuditRecord** (append-only).

---

## 12. External interfaces

| Interface | Direction | Protocol / format |
|-----------|-----------|-------------------|
| Satellite source | in | STAC / openEO; GeoTIFF |
| Weather/agrometeo | in | REST/JSON |
| Node telemetry | in | LoRaWAN → LNS → MQTT/JSON |
| FGW control | bidir | MQTT over mutual TLS |
| Machinery (Tier B) | bidir | agrirouter API; ISO-XML; ADAPT |
| OEM cloud (Tier B) | bidir | via agrirouter (e.g. JD Operations Center) |
| Robot vendor (Tier C) | bidir | per-vendor REST (partnership-gated) |
| Client apps | bidir | HTTPS: GraphQL + REST + WMTS; push notifications |
| Identity | in | OIDC |

---

## 13. Field Gateway — reference hardware design

Two variants share firmware; choose per site.

### 13.1 Variant S — off-grid solar LoRaWAN gateway + edge controller
| Component | Example | Approx. € |
|-----------|---------|-----------|
| Compute (Linux SBC) | Raspberry Pi Zero 2 W / Pi 4 (2 GB) | 18–55 |
| LoRaWAN concentrator | SX1302/SX1303 HAT (RAK2287 / Waveshare) | 90–120 |
| Backhaul | LTE Cat-M/4G USB/HAT + M2M SIM | 25–45 |
| Actuation I/O | relay/MOSFET board for 12 V latching solenoids | 5–12 |
| Feedback I/O | pulse flow meter + pressure sensor input | 15–35 |
| Power | 20–50 W solar + MPPT + LiFePO4 12 V 20–50 Ah | 60–120 |
| Enclosure/antennas | IP65/66, glands, LoRa + LTE antennas | 20–35 |
| Secure element (opt.) | ATECC608 | ~1 |
| **Total** | | **~250–400** |

### 13.2 Variant E — mains/Wi-Fi edge controller (no concentrator; uses existing TTN/gateway)
SBC + relay/feedback I/O + enclosure, mains-powered, backhaul over LAN/Wi-Fi: **~€40–80**. Sensor uplinks ride an existing LoRaWAN gateway; the device is purely the edge control brain + store-and-forward.

*(All figures are 2026 EU ballpark; verify before ordering. Single-channel SX1276 (~€5) is dev-only and not LoRaWAN-compliant.)*

### 13.3 Firmware / edge stack
- **OS:** immutable/reproducible Linux image (Buildroot/Yocto or NixOS) with A/B update partitions.
- **LoRa path:** Semtech UDP packet forwarder → embedded/upstream ChirpStack → MQTT.
- **Edge control agent:** single static binary (Rust recommended) running the rules engine; caches active policies; enforces safety bounds locally.
- **Store-and-forward:** local durable queue (e.g. SQLite/WAL) for telemetry + Intervention records.
- **Connectivity:** MQTT over mutual TLS to cloud; exponential backoff; offline autonomy retained.
- **OTA:** signed image, health-checked, auto-rollback.
- **Observability:** node/agent exporters; buffered push when online.

### 13.4 Edge control semantics
- Cloud sends **policy** (desired state / schedule / bounds), not per-actuation micro-commands.
- Edge closes the loop locally: read → evaluate → actuate latching valve → confirm via flow/pressure → log.
- Idempotent, acknowledged commands; safe-state on sensor loss, flow fault, or bound breach.
- Reversibility gate honoured at the edge: irrigation auto within bounds; dosing beyond threshold / any chemical requires prior cloud-side human approval token.

### 13.5 Power budget (Variant S)
- **NFR-PWR-010 (M):** Size solar + battery for ≥ 5 days autonomy without charge at ~41.6° N winter insolation; concentrator + SBC + LTE duty-cycled; latching valves (near-zero hold current) mandatory to bound energy.

---

## 14. Phasing & traceability

| Phase | Scope | Gate to next |
|-------|-------|--------------|
| **P0 — now** | Tier 0 full (§6): satellite + weather + scouting + insights + portal/app, multi-tenant | Paying Tier-0 users; validated agronomy loop |
| **P1** | Tier A (§7) + FGW Variant E, then S: closed-loop irrigation/fertigation | Reliable off-cloud control; safety validated |
| **P2** | Tier B (§8): agrirouter onboarding, ISO-XML prescriptions, as-applied reconcile | Customers with ISOBUS kit; agronomist sign-off flow |
| **P3** | Tier C (§9): first RobotMissionAdapter for a specific owned robot | A real vendor partnership + a customer that owns the machine |

Each FR/NFR carries a stable ID for traceability into issues, tests, and acceptance criteria. Acceptance = every **Must** in the active tier has a passing verification (test, demo, or measurement).

---

## 15. Assumptions, constraints, open questions

**Assumptions**
- Target crops are high-value and often drip-irrigated (vineyard, olive, orchard, horticulture, tobacco).
- Most target farms own irrigation infrastructure; few own ISOBUS machinery; almost none own autonomous field robots (validates the tier ordering).
- A licensed agronomist is available (employed/partnered) for prescription sign-off.

**Constraints**
- agrirouter is transport/job-exchange, not real-time control — Tier B is inherently asynchronous.
- No open standard controls third-party autonomous robots in real time — Tier C is per-partnership.
- EU/Italy law gates autonomous PPP application (NFR-CMP-040).

**Open questions (to resolve before P1/P2)**
1. First target crop + typical field size (drives zone logic, control cadence, gateway count).
2. Self-hosted ChirpStack vs. TTN vs. Helium for the LNS in the target area's coverage.
3. Soil types on target farms (FDR sensor recalibration burden).
4. Agronomist engagement model (in-house vs. partner) and the exact liability boundary in the DSS framing.
5. Resale/subsidy motion: which 4.0-eligible hardware to stock and install, and the rendicontazione service scope.

---

*End of specification v0.1.*
