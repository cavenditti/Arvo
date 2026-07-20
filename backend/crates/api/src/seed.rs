//! OWNER: integrate-backend — demo tenant seed (`arvo-api seed --demo`, docs/AGENTS.md §Seed spec).
//! Idempotent: re-running produces no duplicates (users/org/farm/parcels keyed by email/name,
//! weather + index series + observations upsert on their natural keys). Uses `imagery::synth`
//! for the index series and runs the anomaly detector (via `jobs`) at the end.
//!
//! Phase P adds the plant tier on top of the same tenant (`run_demo_plants`, bottom of the file):
//! one orchard block on the Uliveto, three demo flights, per-plant series, plant alerts.
use std::collections::HashMap;
use std::f64::consts::PI;

use argon2::password_hash::{PasswordHasher, SaltString};
use argon2::Argon2;
use chrono::{Datelike, Duration, NaiveDate, TimeZone, Utc};
use rand::rngs::OsRng;
use rand::RngCore;
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use arvo_core::agro::{self, AdvisoryKind, ForecastDay, Severity};
use arvo_core::anomaly;
use arvo_core::plant_anomaly as pa;

use crate::imagery::synth;
use crate::jobs;
use crate::state::AppState;

/// The demo tenant's stable keys — the plant seed looks the tenant up by exactly these.
const DEMO_ORG: &str = "Azienda Agricola Demo";
const DEMO_EMAIL: &str = "demo@arvo.local";

// Hand-drawn parcels on the Foggia plain (~15.85E 41.45N). Geometry only (insert wraps in ST_Multi).
const VIGNETO_GEOJSON: &str = r#"{"type":"Polygon","coordinates":[[[15.848,41.4515],[15.852,41.4515],[15.852,41.4525],[15.848,41.4525],[15.848,41.4515]]]}"#;
const ULIVETO_GEOJSON: &str = r#"{"type":"Polygon","coordinates":[[[15.8555,41.4474],[15.8605,41.4474],[15.8605,41.4486],[15.8555,41.4486],[15.8555,41.4474]]]}"#;
const ORTO_GEOJSON: &str = r#"{"type":"Polygon","coordinates":[[[15.84375,41.44455],[15.84625,41.44455],[15.84625,41.44545],[15.84375,41.44545],[15.84375,41.44455]]]}"#;

/// One seeded parcel plus the two flags the later steps need.
struct SeededParcel {
    id: Uuid,
    anomaly: bool,
}

pub async fn run(state: &AppState, demo: bool) -> anyhow::Result<()> {
    if !demo {
        tracing::info!("seed: nothing to do without --demo");
        return Ok(());
    }
    let pool = &state.pool;

    // --- org + users + memberships ---
    let org_id = get_or_create_org(pool, DEMO_ORG).await?;
    let demo_user =
        get_or_create_user(pool, DEMO_EMAIL, "demo1234", "Demo Coltivatore", "it").await?;
    ensure_membership(pool, demo_user, org_id, "owner").await?;
    let agro_user =
        get_or_create_user(pool, "agro@arvo.local", "demo1234", "Agronomo Demo", "it").await?;
    ensure_membership(pool, agro_user, org_id, "agronomist").await?;

    // --- farm ---
    let farm_id = get_or_create_farm(pool, org_id, "Tenuta San Rocco").await?;

    // --- parcels (Vigneto Nord carries the injected NDVI anomaly) ---
    let planting = NaiveDate::from_ymd_opt(2026, 3, 15);
    let specs = [
        (
            "Vigneto Nord",
            VIGNETO_GEOJSON,
            "vine",
            Some("Nero di Troia"),
            planting,
            true,
        ),
        (
            "Uliveto Vecchio",
            ULIVETO_GEOJSON,
            "olive",
            Some("Coratina"),
            None,
            false,
        ),
        (
            "Orto 3",
            ORTO_GEOJSON,
            "tomato",
            Some("San Marzano"),
            None,
            false,
        ),
    ];
    let mut parcels = Vec::new();
    for (name, geo, crop, variety, planting_date, anomaly) in specs {
        let id = get_or_create_parcel(
            pool,
            org_id,
            farm_id,
            name,
            geo,
            crop,
            variety,
            planting_date,
            2026,
        )
        .await?;
        parcels.push(SeededParcel { id, anomaly });
    }

    // --- weather: synthetic 120d + 7d forecast (always), then real Open-Meteo best-effort ---
    let today = Utc::now().date_naive();
    for p in &parcels {
        let (lon, lat) = parcel_centroid(pool, p.id).await?;
        let rows = synth_weather(today);
        upsert_weather(pool, p.id, &rows, WeatherSource::Synthetic).await?;
        match fetch_open_meteo(lat, lon).await {
            Ok(real) if !real.is_empty() => {
                upsert_weather(pool, p.id, &real, WeatherSource::OpenMeteo).await?
            }
            Ok(_) => {}
            Err(e) => {
                tracing::warn!(error = ?e, parcel = %p.id, "seed: open-meteo backfill failed (using synthetic)")
            }
        }
    }

    // --- index series via imagery::synth (18 pts Mar→today, crop-plausible NDVI + noise) ---
    for p in &parcels {
        seed_indices(pool, p.id, p.anomaly).await?;
    }

    // --- frost/heat alerts from the forecast, if warranted (best-effort) ---
    for p in &parcels {
        seed_advisory_alerts(pool, org_id, p.id).await?;
    }

    // --- anomaly detector → index_drop alert for Vigneto Nord ---
    let created = jobs::detect_all(state).await?;
    tracing::info!(created, "seed: anomaly detector run");

    // The detector prefers real sentinel-2 series when they exist (source precedence), so on
    // machines that have run `make ingest` the synthetic dip alone can no longer produce the
    // demo alert. The demo promise (AGENTS §Seed: Vigneto Nord carries an anomaly alert) is
    // guaranteed here directly from the synthetic dip instead.
    for p in parcels.iter().filter(|p| p.anomaly) {
        seed_demo_drop_alert(pool, org_id, p.id).await?;
    }

    // --- scouting observations (one deleted tombstone) ---
    seed_observations(pool, org_id, demo_user, &parcels).await?;

    // --- Phase-P plant tier: orchard block + demo flights on the Uliveto (olive → `tree`) ---
    // Goes through the same entry point `seed --demo-plants` calls, so the standalone path is
    // exercised on every `make seed` (and, being idempotent, a later `make seed-plants` is a no-op).
    run_demo_plants(state).await?;

    // --- STAC scene refresh per parcel (best-effort; skips offline) ---
    if let Err(e) = crate::imagery::ingest_all(state, None).await {
        tracing::warn!(error = ?e, "seed: STAC refresh failed (skipped)");
    }

    tracing::info!(org = %org_id, "seed --demo complete");
    Ok(())
}

// ---------------------------------------------------------------------------
// tenant helpers (all get-or-create for idempotency)
// ---------------------------------------------------------------------------

async fn get_or_create_org(pool: &sqlx::PgPool, name: &str) -> anyhow::Result<Uuid> {
    if let Some((id,)) = sqlx::query_as::<_, (Uuid,)>(
        "SELECT id FROM orgs WHERE name = $1 ORDER BY created_at LIMIT 1",
    )
    .bind(name)
    .fetch_optional(pool)
    .await?
    {
        return Ok(id);
    }
    let (id,) = sqlx::query_as::<_, (Uuid,)>("INSERT INTO orgs (name) VALUES ($1) RETURNING id")
        .bind(name)
        .fetch_one(pool)
        .await?;
    Ok(id)
}

async fn get_or_create_user(
    pool: &sqlx::PgPool,
    email: &str,
    password: &str,
    full_name: &str,
    locale: &str,
) -> anyhow::Result<Uuid> {
    if let Some((id,)) =
        sqlx::query_as::<_, (Uuid,)>("SELECT id FROM users WHERE lower(email) = lower($1)")
            .bind(email)
            .fetch_optional(pool)
            .await?
    {
        return Ok(id);
    }
    let hash = hash_password(password)?;
    let (id,) = sqlx::query_as::<_, (Uuid,)>(
        "INSERT INTO users (email, password_hash, full_name, locale)
         VALUES ($1, $2, $3, $4) RETURNING id",
    )
    .bind(email)
    .bind(&hash)
    .bind(full_name)
    .bind(locale)
    .fetch_one(pool)
    .await?;
    Ok(id)
}

async fn ensure_membership(
    pool: &sqlx::PgPool,
    user_id: Uuid,
    org_id: Uuid,
    role: &str,
) -> anyhow::Result<()> {
    // DO UPDATE: truly idempotent — a pre-existing membership converges on the seeded role.
    sqlx::query(
        "INSERT INTO memberships (user_id, org_id, role) VALUES ($1, $2, $3::org_role)
         ON CONFLICT (user_id, org_id) DO UPDATE SET role = EXCLUDED.role",
    )
    .bind(user_id)
    .bind(org_id)
    .bind(role)
    .execute(pool)
    .await?;
    Ok(())
}

async fn get_or_create_farm(pool: &sqlx::PgPool, org_id: Uuid, name: &str) -> anyhow::Result<Uuid> {
    if let Some((id,)) = sqlx::query_as::<_, (Uuid,)>(
        "SELECT id FROM farms WHERE org_id = $1 AND name = $2 ORDER BY created_at LIMIT 1",
    )
    .bind(org_id)
    .bind(name)
    .fetch_optional(pool)
    .await?
    {
        return Ok(id);
    }
    let (id,) = sqlx::query_as::<_, (Uuid,)>(
        "INSERT INTO farms (org_id, name) VALUES ($1, $2) RETURNING id",
    )
    .bind(org_id)
    .bind(name)
    .fetch_one(pool)
    .await?;
    Ok(id)
}

#[allow(clippy::too_many_arguments)]
async fn get_or_create_parcel(
    pool: &sqlx::PgPool,
    org_id: Uuid,
    farm_id: Uuid,
    name: &str,
    geometry: &str,
    crop: &str,
    variety: Option<&str>,
    planting_date: Option<NaiveDate>,
    season_year: i32,
) -> anyhow::Result<Uuid> {
    if let Some((id,)) = sqlx::query_as::<_, (Uuid,)>(
        "SELECT id FROM parcels WHERE org_id = $1 AND name = $2 ORDER BY created_at LIMIT 1",
    )
    .bind(org_id)
    .bind(name)
    .fetch_optional(pool)
    .await?
    {
        return Ok(id);
    }
    let (id,) = sqlx::query_as::<_, (Uuid,)>(
        "INSERT INTO parcels (org_id, farm_id, name, geom, crop, variety, planting_date, season_year)
         VALUES ($1, $2, $3, ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($4), 4326)), $5, $6, $7, $8)
         RETURNING id",
    )
    .bind(org_id)
    .bind(farm_id)
    .bind(name)
    .bind(geometry)
    .bind(crop)
    .bind(variety)
    .bind(planting_date)
    .bind(season_year)
    .fetch_one(pool)
    .await?;
    Ok(id)
}

async fn parcel_centroid(pool: &sqlx::PgPool, parcel_id: Uuid) -> anyhow::Result<(f64, f64)> {
    let row = sqlx::query_as::<_, (f64, f64)>(
        "SELECT ST_X(ST_Centroid(geom)), ST_Y(ST_Centroid(geom)) FROM parcels WHERE id = $1",
    )
    .bind(parcel_id)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

fn hash_password(password: &str) -> anyhow::Result<String> {
    let mut salt_bytes = [0u8; 16];
    OsRng.fill_bytes(&mut salt_bytes);
    let salt = SaltString::encode_b64(&salt_bytes).map_err(|e| anyhow::anyhow!("salt: {e}"))?;
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| anyhow::anyhow!("password hash: {e}"))
}

// ---------------------------------------------------------------------------
// index series
// ---------------------------------------------------------------------------

async fn seed_indices(pool: &sqlx::PgPool, parcel_id: Uuid, anomaly: bool) -> anyhow::Result<()> {
    let obs = synth::series(parcel_id, anomaly);
    let mut tx = pool.begin().await?;
    // Replace our own synthetic rows wholesale: date grids from earlier runs (and their
    // injected anomaly dips) must not linger mid-series. Real `sentinel-2` rows are kept.
    sqlx::query("DELETE FROM index_observations WHERE parcel_id = $1 AND source = 'demo'")
        .bind(parcel_id)
        .execute(&mut *tx)
        .await?;
    for o in &obs {
        sqlx::query(
            "INSERT INTO index_observations
               (parcel_id, index_name, observed_at, mean, median, p10, p90, stddev,
                pixel_count, cloud_pct, source)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             ON CONFLICT (parcel_id, index_name, observed_at) DO UPDATE SET
               mean = EXCLUDED.mean, median = EXCLUDED.median, p10 = EXCLUDED.p10,
               p90 = EXCLUDED.p90, stddev = EXCLUDED.stddev, pixel_count = EXCLUDED.pixel_count,
               cloud_pct = EXCLUDED.cloud_pct, source = EXCLUDED.source",
        )
        .bind(parcel_id)
        .bind(o.index_name)
        .bind(o.observed_at)
        .bind(o.mean)
        .bind(o.median)
        .bind(o.p10)
        .bind(o.p90)
        .bind(o.stddev)
        .bind(o.pixel_count)
        .bind(o.cloud_pct)
        .bind(o.source)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// weather (synthetic generator + best-effort Open-Meteo)
// ---------------------------------------------------------------------------

/// Nullable fields mirror the schema: a missing Open-Meteo value stays NULL — fabricating
/// `0.0` would trip the frost advisory (t_min < 2) and skew the water balance (et0 = 0).
struct WeatherRow {
    date: NaiveDate,
    t_min: Option<f64>,
    t_max: Option<f64>,
    t_mean: Option<f64>,
    precip_mm: Option<f64>,
    humidity_mean: Option<f64>,
    wind_max_kmh: Option<f64>,
    radiation_mj: Option<f64>,
    et0_mm: Option<f64>,
    is_forecast: bool,
}

/// Plausible Foggia daily weather for the last 120 days plus a 7-day forecast. Deterministic
/// (keyed on day-of-year) so re-seeding is stable. Two consecutive forecast days are pushed
/// into extreme heat so the demo exercises a heat_stress advisory/alert.
fn synth_weather(today: NaiveDate) -> Vec<WeatherRow> {
    let start = today - Duration::days(120);
    let end = today + Duration::days(7);
    let mut rows = Vec::new();
    let mut date = start;
    while date <= end {
        let doy = date.ordinal() as f64;
        // Seasonal mean: ~7 °C midwinter → ~26 °C late July (peak near day 205).
        let t_mean = 16.5 + 9.5 * (2.0 * PI * (doy - 205.0) / 365.0).cos();
        let mut t_min = t_mean - 6.0;
        let mut t_max = t_mean + 7.0;

        // A dry Mediterranean regime: a little rain roughly every 9th day.
        let precip_mm = if (date.num_days_from_ce() % 9) == 0 {
            7.5
        } else {
            0.0
        };
        let humidity_mean = if precip_mm > 0.0 { 78.0 } else { 60.0 };
        let wind_max_kmh = 6.0 + (doy % 11.0);
        let radiation_mj =
            (8.0 + 16.0 * ((2.0 * PI * (doy - 205.0) / 365.0).cos() + 1.0) / 2.0).clamp(4.0, 28.0);
        let mut et0_mm = ((t_max - 5.0).max(0.0) * 0.13 + 0.8).clamp(0.5, 8.0);

        // Extreme-heat spell on today+3 / today+4 (drives a critical heat_stress advisory).
        if date == today + Duration::days(3) {
            t_max = 38.5;
            t_min = 24.0;
            et0_mm = 7.2;
        } else if date == today + Duration::days(4) {
            t_max = 39.5;
            t_min = 25.0;
            et0_mm = 7.6;
        }

        rows.push(WeatherRow {
            date,
            t_min: Some(round1(t_min)),
            t_max: Some(round1(t_max)),
            t_mean: Some(round1(t_mean)),
            precip_mm: Some(precip_mm),
            humidity_mean: Some(humidity_mean),
            wind_max_kmh: Some(round1(wind_max_kmh)),
            radiation_mj: Some(round1(radiation_mj)),
            et0_mm: Some(round1(et0_mm)),
            is_forecast: date >= today,
        });
        date += Duration::days(1);
    }
    rows
}

/// `synthetic` rows never overwrite real (`open-meteo`) rows; real rows always win.
enum WeatherSource {
    Synthetic,
    OpenMeteo,
}

async fn upsert_weather(
    pool: &sqlx::PgPool,
    parcel_id: Uuid,
    rows: &[WeatherRow],
    source: WeatherSource,
) -> anyhow::Result<()> {
    let (source, guard) = match source {
        // A synthetic re-run (e.g. offline) must not downgrade previously-fetched real data.
        WeatherSource::Synthetic => ("synthetic", "WHERE weather_daily.source = 'synthetic'"),
        WeatherSource::OpenMeteo => ("open-meteo", ""),
    };
    let sql = format!(
        "INSERT INTO weather_daily
           (parcel_id, date, t_min, t_max, t_mean, precip_mm, humidity_mean,
            wind_max_kmh, radiation_mj, et0_mm, is_forecast, fetched_at, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now(), $12)
         ON CONFLICT (parcel_id, date) DO UPDATE SET
           t_min = EXCLUDED.t_min, t_max = EXCLUDED.t_max, t_mean = EXCLUDED.t_mean,
           precip_mm = EXCLUDED.precip_mm, humidity_mean = EXCLUDED.humidity_mean,
           wind_max_kmh = EXCLUDED.wind_max_kmh, radiation_mj = EXCLUDED.radiation_mj,
           et0_mm = EXCLUDED.et0_mm, is_forecast = EXCLUDED.is_forecast,
           fetched_at = now(), source = EXCLUDED.source
         {guard}"
    );
    let mut tx = pool.begin().await?;
    for r in rows {
        sqlx::query(&sql)
            .bind(parcel_id)
            .bind(r.date)
            .bind(r.t_min)
            .bind(r.t_max)
            .bind(r.t_mean)
            .bind(r.precip_mm)
            .bind(r.humidity_mean)
            .bind(r.wind_max_kmh)
            .bind(r.radiation_mj)
            .bind(r.et0_mm)
            .bind(r.is_forecast)
            .bind(source)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

#[derive(Deserialize)]
struct OmResponse {
    daily: Option<OmDaily>,
}

#[derive(Default, Deserialize)]
struct OmDaily {
    #[serde(default)]
    time: Vec<String>,
    #[serde(default)]
    temperature_2m_min: Vec<Option<f64>>,
    #[serde(default)]
    temperature_2m_max: Vec<Option<f64>>,
    #[serde(default)]
    temperature_2m_mean: Vec<Option<f64>>,
    #[serde(default)]
    precipitation_sum: Vec<Option<f64>>,
    #[serde(default)]
    relative_humidity_2m_mean: Vec<Option<f64>>,
    #[serde(default)]
    wind_speed_10m_max: Vec<Option<f64>>,
    #[serde(default)]
    shortwave_radiation_sum: Vec<Option<f64>>,
    #[serde(default)]
    et0_fao_evapotranspiration: Vec<Option<f64>>,
}

/// Best-effort real backfill: one Open-Meteo forecast call with 92 past days + 7 forecast days.
/// Errors bubble up so the caller can log and keep the synthetic rows.
async fn fetch_open_meteo(lat: f64, lon: f64) -> anyhow::Result<Vec<WeatherRow>> {
    const URL: &str = "https://api.open-meteo.com/v1/forecast";
    const VARS: &str = "temperature_2m_max,temperature_2m_min,temperature_2m_mean,precipitation_sum,relative_humidity_2m_mean,wind_speed_10m_max,shortwave_radiation_sum,et0_fao_evapotranspiration";
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()?;
    let params = [
        ("latitude", lat.to_string()),
        ("longitude", lon.to_string()),
        ("daily", VARS.to_string()),
        ("timezone", "auto".to_string()),
        ("past_days", "92".to_string()),
        ("forecast_days", "7".to_string()),
    ];
    let body: OmResponse = client
        .get(URL)
        .query(&params)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let daily = body.daily.unwrap_or_default();
    let today = Utc::now().date_naive();
    let mut rows = Vec::new();
    for (i, t) in daily.time.iter().enumerate() {
        let Ok(date) = NaiveDate::parse_from_str(t, "%Y-%m-%d") else {
            continue;
        };
        let g = |v: &Vec<Option<f64>>| v.get(i).copied().flatten();
        let t_min = g(&daily.temperature_2m_min);
        let t_max = g(&daily.temperature_2m_max);
        rows.push(WeatherRow {
            date,
            t_min,
            t_max,
            t_mean: g(&daily.temperature_2m_mean).or_else(|| Some((t_min? + t_max?) / 2.0)),
            precip_mm: g(&daily.precipitation_sum),
            humidity_mean: g(&daily.relative_humidity_2m_mean),
            wind_max_kmh: g(&daily.wind_speed_10m_max),
            radiation_mj: g(&daily.shortwave_radiation_sum),
            et0_mm: g(&daily.et0_fao_evapotranspiration),
            is_forecast: date >= today,
        });
    }
    Ok(rows)
}

// ---------------------------------------------------------------------------
// advisory-driven frost/heat alerts (mirrors weather.rs; deduped on kind:parcel:date)
// ---------------------------------------------------------------------------

async fn seed_advisory_alerts(
    pool: &sqlx::PgPool,
    org_id: Uuid,
    parcel_id: Uuid,
) -> anyhow::Result<()> {
    // The dedupe key embeds the forecast date, which moves every day — without cleanup a
    // daily re-seed accumulates one stale pair of heat alerts per run. Expired, still-open
    // advisory alerts (forecast date already past) are dropped before seeding new ones.
    sqlx::query(
        "DELETE FROM alerts
         WHERE org_id = $1 AND parcel_id = $2 AND state = 'open'
           AND data->>'source' = 'advisory' AND (data->>'date')::date < CURRENT_DATE",
    )
    .bind(org_id)
    .bind(parcel_id)
    .execute(pool)
    .await?;

    let forecast = sqlx::query_as::<
        _,
        (
            NaiveDate,
            Option<f64>,
            Option<f64>,
            Option<f64>,
            Option<f64>,
        ),
    >(
        "SELECT date, t_min, t_max, precip_mm, wind_max_kmh
         FROM weather_daily WHERE parcel_id = $1 AND is_forecast = true AND date >= CURRENT_DATE
         ORDER BY date",
    )
    .bind(parcel_id)
    .fetch_all(pool)
    .await?;

    let days: Vec<ForecastDay> = forecast
        .iter()
        .map(
            |(date, t_min, t_max, precip_mm, wind_max_kmh)| ForecastDay {
                date: *date,
                t_min: *t_min,
                t_max: *t_max,
                precip_mm: *precip_mm,
                wind_max_kmh: *wind_max_kmh,
            },
        )
        .collect();

    for a in agro::advisories(&days) {
        if a.severity != Severity::Critical
            || !matches!(a.kind, AdvisoryKind::FrostRisk | AdvisoryKind::HeatStress)
        {
            continue;
        }
        let dedupe_key = format!("{}:{}:{}", a.kind.as_str(), parcel_id, a.date);
        let (title, message) = match a.kind {
            AdvisoryKind::HeatStress => (
                "Caldo estremo".to_string(),
                format!(
                    "Caldo estremo il {}: massima {:.1}°C. Elevato stress idrico; valutare l'irrigazione.",
                    a.date,
                    a.value.unwrap_or(0.0)
                ),
            ),
            _ => (
                "Gelo intenso".to_string(),
                format!(
                    "Gelo intenso previsto il {}: minima {:.1}°C. Alto rischio di danni.",
                    a.date,
                    a.value.unwrap_or(0.0)
                ),
            ),
        };
        sqlx::query(
            "INSERT INTO alerts (org_id, parcel_id, kind, severity, title, message, data, dedupe_key)
             VALUES ($1,$2,$3,'critical',$4,$5,$6,$7)
             ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING",
        )
        .bind(org_id)
        .bind(parcel_id)
        .bind(a.kind.as_str())
        .bind(&title)
        .bind(&message)
        .bind(json!({ "date": a.date, "value": a.value, "source": "advisory" }))
        .bind(&dedupe_key)
        .execute(pool)
        .await?;
    }
    Ok(())
}

/// Upsert the demo `index_drop` alert from the synthetic NDVI dip (deduped per parcel+day,
/// same key shape as the real detector so the two can never double-report one day).
async fn seed_demo_drop_alert(
    pool: &sqlx::PgPool,
    org_id: Uuid,
    parcel_id: Uuid,
) -> anyhow::Result<()> {
    let series: Vec<(chrono::DateTime<Utc>, f64)> = sqlx::query_as(
        "SELECT observed_at, mean FROM index_observations
         WHERE parcel_id = $1 AND index_name = 'ndvi' AND source = 'demo'
         ORDER BY observed_at ASC",
    )
    .bind(parcel_id)
    .fetch_all(pool)
    .await?;
    let points: Vec<anomaly::SeriesPoint> = series
        .iter()
        .map(|(observed_at, mean)| anomaly::SeriesPoint {
            observed_at: *observed_at,
            mean: *mean,
        })
        .collect();
    let Some(event) = anomaly::detect_latest(&points) else {
        return Ok(()); // series too short (early season) — nothing to report
    };

    let name: String = sqlx::query_scalar("SELECT name FROM parcels WHERE id = $1")
        .bind(parcel_id)
        .fetch_one(pool)
        .await?;
    let date = event.observed_at.date_naive();
    let pct = (event.drop_pct * 100.0).round() as i64;
    sqlx::query(
        "INSERT INTO alerts (org_id, parcel_id, kind, severity, title, message, data, dedupe_key)
         VALUES ($1, $2, 'index_drop', $3, $4, $5, $6, $7)
         ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING",
    )
    .bind(org_id)
    .bind(parcel_id)
    .bind(event.severity.as_str())
    .bind(format!("NDVI drop on {name}"))
    .bind(format!(
        "NDVI dropped {pct}% below the {}-day baseline ({:.2} → {:.2})",
        anomaly::BASELINE_WINDOW_DAYS,
        event.baseline,
        event.value
    ))
    .bind(json!({
        "index": "ndvi", "value": event.value, "baseline": event.baseline,
        "drop_pct": event.drop_pct, "source": "demo",
    }))
    .bind(format!("index_drop:{parcel_id}:{date}"))
    .execute(pool)
    .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// scouting observations
// ---------------------------------------------------------------------------

async fn seed_observations(
    pool: &sqlx::PgPool,
    org_id: Uuid,
    author_id: Uuid,
    parcels: &[SeededParcel],
) -> anyhow::Result<()> {
    // Deterministic client UUIDs so re-seeding dedupes on the primary key.
    let vigneto = parcels[0].id;
    let uliveto = parcels[1].id;
    let orto = parcels[2].id;

    /// (uuid low bits, parcel, note, tags, days_ago, deleted)
    type ObsSpec = (u128, Uuid, &'static str, &'static [&'static str], i64, bool);
    /// Recognizable 0xDE… prefix for the deterministic demo observation UUIDs.
    const OBS_ID_PREFIX: u128 = 0xDE << 120;

    let specs: [ObsSpec; 5] = [
        (
            0xa1,
            vigneto,
            "Presenza di oidio su alcune foglie nel filare 3.",
            &["malattia", "oidio"],
            20,
            false,
        ),
        (
            0xa2,
            vigneto,
            "Ingiallimento fogliare localizzato, possibile carenza di magnesio.",
            &["nutrizione"],
            8,
            false,
        ),
        (
            0xa3,
            uliveto,
            "Installate le trappole cromotropiche per la mosca olearia.",
            &["monitoraggio", "mosca"],
            12,
            false,
        ),
        (
            0xa4,
            orto,
            "Impianto di irrigazione a goccia verificato e funzionante.",
            &["irrigazione"],
            5,
            false,
        ),
        (0xa5, orto, "Nota duplicata rimossa.", &[], 15, true),
    ];

    for (n, parcel_id, note, tags, days_ago, deleted) in specs {
        let id = Uuid::from_u128(OBS_ID_PREFIX | n);
        let (lon, lat) = parcel_centroid(pool, parcel_id).await?;
        let taken_at = Utc.from_utc_datetime(
            &(Utc::now().date_naive() - Duration::days(days_ago))
                .and_hms_opt(9, 30, 0)
                .unwrap(),
        );
        let tags_vec: Vec<String> = tags.iter().map(|s| s.to_string()).collect();
        sqlx::query(
            "INSERT INTO observations
               (id, org_id, parcel_id, author_id, lon, lat, note, tags, photos, taken_at, deleted, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'[]'::jsonb,$9,$10,$9)
             ON CONFLICT (id) DO NOTHING",
        )
        .bind(id)
        .bind(org_id)
        .bind(parcel_id)
        .bind(author_id)
        .bind(lon)
        .bind(lat)
        .bind(note)
        .bind(&tags_vec)
        .bind(taken_at)
        .bind(deleted)
        .execute(pool)
        .await?;
    }
    Ok(())
}

fn round1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

// ---------------------------------------------------------------------------
// Phase-P plant tier (docs/API-PLANT.md §"Seed & smoke", docs/PHASE-PLANT.md §9)
// ---------------------------------------------------------------------------

/// Olive is the natural `tree` unit, so the orchard block lands on the seeded olive parcel.
const PLANT_PARCEL: &str = "Uliveto Vecchio";
const PLANT_BLOCK: &str = "Blocco A";
/// 15 rows × 20 trees on a 6 m grid = 300 plants over 84 m × 114 m, centred on the parcel
/// centroid — comfortably inside the ~133 m × 417 m Uliveto polygon.
const GRID_ROWS: i32 = 15;
const GRID_COLS: i32 = 20;
const SPACING_M: f64 = 6.0;
/// Flights sit on an absolute date grid, exactly like `imagery::synth`: interior dates never
/// move as `today` advances, so re-seeding on a later day *adds* a flight instead of shifting
/// every date (which would strand the previous captures' observations mid-series).
const FLIGHT_INTERVAL_DAYS: i64 = 28;
const FLIGHT_COUNT: i64 = 3;
/// The synthetic sampler's stamp (docs/API-PLANT.md §Extraction, NFR-P-REPRO). These rows are
/// `plant_observations`, i.e. the *extract* stage, so this must equal the synthetic extractor's
/// `worker::extract::SYNTH_EXTRACTOR_VER` — not the synthetic *detector*'s `synth-0.1.0`, which
/// stamps `plant_detections` instead. Keeping them equal is what makes a seeded row and a
/// `source="demo"` pipeline row honest twins: re-processing a seeded capture with `arvo-worker`
/// rewrites the same `model_ver` rather than silently changing the provenance stamp surfaced by
/// `GET /plants/{id}/series` and `GET /plants/{id}/captures`.
const PLANT_MODEL_VER: &str = "synth-extract-0.1.0";
/// (row, col), 1-based: the centre of the failing patch, and the gap in the grid. These two are
/// the point of the seed — without them the neighbour detector and the replant list have nothing
/// to find (the plant-tier counterpart of the Tier-0 injected NDVI dip).
const WEAK_CENTRE: (i32, i32) = (8, 13);
const MISSING_CELL: (i32, i32) = (4, 6);
/// The patch is a Gaussian NDVI deficit (σ ≈ one spacing, so ~9 trees read as low-vigor)…
const WEAK_SIGMA_M: f64 = 5.0;
const WEAK_DEPTH: f64 = 0.20;
/// …with one tree inside it that is genuinely dying. That extra deficit is what makes the centre
/// tree an outlier *against its own already-weak patch* (robust z ≈ −7 on the last flight): a
/// uniformly low patch hides every member of it, because each tree's neighbours are the other
/// sick ones and the median moves with them.
const WEAK_CENTRE_EXTRA: f64 = 0.16;
/// Deterministic id for the field note pinned to the failing tree (`0xDE…` demo prefix).
const PLANT_NOTE_ID: u128 = (0xDEu128 << 120) | 0xb1;

/// `arvo-api seed --demo-plants` — the Phase-P demo orchard on top of an existing `--demo`
/// tenant. Idempotent: plants key on `external_ref`, flights on `flight_ref`, observations on
/// their primary key, alerts on their dedupe key.
///
/// Requires the `--demo` tenant to exist already (it resolves the demo org and parcel by name and
/// bails otherwise), so the standalone order is `make seed` then `make seed-plants`. `run(..,
/// demo = true)` also calls this directly, so `make seed` alone already produces the full demo.
pub async fn run_demo_plants(state: &AppState) -> anyhow::Result<()> {
    let pool = &state.pool;
    let org_id: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM orgs WHERE name = $1 ORDER BY created_at LIMIT 1")
            .bind(DEMO_ORG)
            .fetch_optional(pool)
            .await?;
    let Some(org_id) = org_id else {
        anyhow::bail!("demo org {DEMO_ORG:?} not found — run `arvo-api seed --demo` first");
    };
    let parcel_id: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM parcels WHERE org_id = $1 AND name = $2 ORDER BY created_at LIMIT 1",
    )
    .bind(org_id)
    .bind(PLANT_PARCEL)
    .fetch_optional(pool)
    .await?;
    let Some(parcel_id) = parcel_id else {
        anyhow::bail!("demo parcel {PLANT_PARCEL:?} not found — run `arvo-api seed --demo` first");
    };
    let author: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM users WHERE lower(email) = lower($1)")
            .bind(DEMO_EMAIL)
            .fetch_optional(pool)
            .await?;
    seed_plant_tier(state, org_id, parcel_id, author).await
}

/// One grid position. `missing` marks the single tree that is no longer there.
struct GridCell {
    row: i32,
    col: i32,
    lon: f64,
    lat: f64,
    missing: bool,
}

impl GridCell {
    /// Human field label, "R08-P13" — row first, exactly how the block is walked.
    fn label(&self) -> String {
        format!("R{:02}-P{:02}", self.row, self.col)
    }
    /// The grower's tag, and the seed's idempotency key (UNIQUE (parcel_id, external_ref)).
    fn external_ref(&self) -> String {
        format!("UV-A-{}", self.label())
    }
}

/// Block + rows + plants + the demo flights, their per-plant series, the parcel rollup and the
/// plant alerts. Every step is an upsert on a stable key, so a re-run converges instead of
/// duplicating (and, crucially, plant ids survive — alerts and field notes point at them).
async fn seed_plant_tier(
    state: &AppState,
    org_id: Uuid,
    parcel_id: Uuid,
    author: Option<Uuid>,
) -> anyhow::Result<()> {
    let pool = &state.pool;
    let (clon, clat) = parcel_centroid(pool, parcel_id).await?;
    let cells = grid_cells(clon, clat);
    let (w, s, e, n) = grid_bounds(&cells, clat);

    let block_id = get_or_create_block(pool, org_id, parcel_id, (w, s, e, n)).await?;
    let mut row_ids = Vec::with_capacity(GRID_ROWS as usize);
    for r in 1..=GRID_ROWS {
        let lat = cells[((r - 1) * GRID_COLS) as usize].lat;
        row_ids.push(
            get_or_create_plant_row(pool, org_id, parcel_id, block_id, r, (w, e, lat)).await?,
        );
    }
    let plant_ids = upsert_plants(pool, org_id, parcel_id, block_id, &row_ids, &cells).await?;

    // --- flights: one `source='demo'` capture per date, already `extracted` ---
    let dates = flight_dates(Utc::now().date_naive());
    let last = dates.len().saturating_sub(1);
    let mut latest: Option<(Uuid, NaiveDate)> = None;
    for (i, date) in dates.iter().enumerate() {
        let captured_at = Utc.from_utc_datetime(&date.and_hms_opt(10, 30, 0).unwrap());
        let capture_id =
            get_or_create_capture(pool, org_id, parcel_id, captured_at, author).await?;

        // The patch declines across the season, so the plant's own series carries the story too
        // (FR-P-044 growth curves, and `core::anomaly` per plant for FR-P-041).
        let decline = (i + 1) as f64 / dates.len() as f64;
        let t = season_t(*date);
        let mut samples = Samples::default();
        for (c, cell) in cells.iter().enumerate() {
            // The gap was still standing on the earlier flights: that is what gives the replant
            // list a `last_seen_at` and makes `missing` a history, not a flag out of nowhere.
            if cell.missing && i == last {
                continue;
            }
            let ndvi = demo_ndvi(cell, t, decline, i as u32);
            let vigor = ((ndvi - 0.30) / 0.45).clamp(0.0, 1.0);
            let q =
                (88.0 + 8.0 * jitter(cell.row, cell.col, 31 + i as u32)).clamp(0.0, 100.0) as i16;
            samples.push(plant_ids[c], "ndvi", ndvi, q);
            samples.push(plant_ids[c], "ndre", 0.68 * ndvi, q);
            let canopy = 5.0 + 10.0 * vigor + 0.4 * jitter(cell.row, cell.col, 71);
            samples.push(plant_ids[c], "canopy_m2", canopy, q);
            let height = 2.6 + 2.4 * vigor + 0.1 * jitter(cell.row, cell.col, 113);
            samples.push(plant_ids[c], "height_m", height, q);
        }
        write_samples(pool, org_id, parcel_id, capture_id, captured_at, &samples).await?;
        rollup_capture(pool, parcel_id, capture_id).await?;
        finish_capture(pool, org_id, capture_id, (w, s, e, n)).await?;
        latest = Some((capture_id, *date));
    }

    // --- alerts: the neighbour detector's own definition, run over the last flight ---
    if let Some((capture_id, date)) = latest {
        let found = seed_plant_outlier_alerts(state, org_id, parcel_id, capture_id, date).await?;
        if found == 0 {
            tracing::warn!("seed: no plant_vigor_outlier produced — the demo vigor field is flat");
        }
        seed_missing_plant_alerts(pool, org_id, parcel_id).await?;
    }

    // --- one field note pinned to the failing tree (FR-P-060) ---
    if let (Some(author), Some(idx)) = (
        author,
        cells.iter().position(|c| (c.row, c.col) == WEAK_CENTRE),
    ) {
        seed_plant_note(pool, org_id, parcel_id, plant_ids[idx], author, &cells[idx]).await?;
    }

    tracing::info!(parcel = %parcel_id, plants = cells.len(), flights = dates.len(),
                   "seed: demo plant tier complete");
    Ok(())
}

/// Row-major grid, row 1 northernmost and column 1 westernmost so the labels read like a field
/// walk. Metres → degrees is the flat-earth approximation, which over 114 m is exact enough that
/// PostGIS geography distances still come out at the nominal spacing.
fn grid_cells(clon: f64, clat: f64) -> Vec<GridCell> {
    let m_per_deg_lat = 111_320.0;
    let m_per_deg_lon = 111_320.0 * clat.to_radians().cos();
    let mut cells = Vec::with_capacity((GRID_ROWS * GRID_COLS) as usize);
    for row in 1..=GRID_ROWS {
        for col in 1..=GRID_COLS {
            let dx = (col as f64 - (GRID_COLS as f64 + 1.0) / 2.0) * SPACING_M;
            let dy = ((GRID_ROWS as f64 + 1.0) / 2.0 - row as f64) * SPACING_M;
            cells.push(GridCell {
                row,
                col,
                lon: clon + dx / m_per_deg_lon,
                lat: clat + dy / m_per_deg_lat,
                missing: (row, col) == MISSING_CELL,
            });
        }
    }
    cells
}

/// Grid envelope plus a 3 m headland: the block polygon and the captures' `bbox`.
fn grid_bounds(cells: &[GridCell], clat: f64) -> (f64, f64, f64, f64) {
    const MARGIN_M: f64 = 3.0;
    let dlat = MARGIN_M / 111_320.0;
    let dlon = MARGIN_M / (111_320.0 * clat.to_radians().cos());
    let fold = |f: fn(f64, f64) -> f64, get: fn(&GridCell) -> f64, init: f64| {
        cells.iter().fold(init, |acc, c| f(acc, get(c)))
    };
    (
        fold(f64::min, |c| c.lon, f64::INFINITY) - dlon,
        fold(f64::min, |c| c.lat, f64::INFINITY) - dlat,
        fold(f64::max, |c| c.lon, f64::NEG_INFINITY) + dlon,
        fold(f64::max, |c| c.lat, f64::NEG_INFINITY) + dlat,
    )
}

/// Deterministic ±1 wobble from a grid cell — a hash, not an RNG, so a re-seed rewrites the
/// exact same values (idempotency on the value, not merely on the row).
fn jitter(a: i32, b: i32, salt: u32) -> f64 {
    let mut h = (a as u32).wrapping_mul(0x9E37_79B9)
        ^ (b as u32).wrapping_mul(0x85EB_CA6B)
        ^ salt.wrapping_mul(0xC2B2_AE35);
    h ^= h >> 15;
    h = h.wrapping_mul(0x2545_F491);
    h ^= h >> 13;
    (h as f64 / u32::MAX as f64) * 2.0 - 1.0
}

/// Season fraction Mar→Oct — the same arc `imagery::synth` walks for the parcel curve.
fn season_t(date: NaiveDate) -> f64 {
    let year = if date.month() >= 3 {
        date.year()
    } else {
        date.year() - 1
    };
    let start = NaiveDate::from_ymd_opt(year, 3, 1).unwrap();
    ((date - start).num_days() as f64 / 214.0).clamp(0.0, 1.0)
}

/// The synthetic vigor field: a plausible olive canopy that greens up over the season, a soil
/// gradient across the block, a small per-tree wobble, and the failing patch (scaled by
/// `decline`, so it deepens flight after flight).
///
/// The **shape** of the healthy part is what makes this field honest for a neighbour-relative
/// detector, and it is worth spelling out. The detector asks "is this tree below the median of
/// the eight around it, relative to their spread". With independent per-tree noise the answer is
/// yes for a few percent of perfectly healthy trees (the tail of the noise), and with a bumpy
/// field it is yes at the bottom of every bump — the demo would ship a dozen alerts on healthy
/// trees, some of them `critical`. A **planar** trend has neither artefact: every tree sits
/// exactly at its neighbours' median, while the slope still gives the neighbourhood a real MAD
/// to divide by. So the healthy field is a plane plus a wobble kept well under the per-step
/// slope, and the only trees the detector reports are the ones planted to be reported.
fn demo_ndvi(cell: &GridCell, t: f64, decline: f64, salt: u32) -> f64 {
    let base = 0.55 + 0.20 * t;
    // Deeper soil to the east, a drier headland to the north: ~0.08 NDVI across the 114 m of
    // block and 0.045 across its 84 m, i.e. ~0.004 between adjacent trees. Kept well under the
    // patch depth so the failing corner of the field is the patch, not the block gradient.
    let gx = (cell.col - 1) as f64 / (GRID_COLS - 1) as f64 - 0.5;
    let gy = (cell.row - 1) as f64 / (GRID_ROWS - 1) as f64 - 0.5;
    let gradient = 0.08 * gx - 0.045 * gy;
    let dx = (cell.col - WEAK_CENTRE.1) as f64 * SPACING_M;
    let dy = (cell.row - WEAK_CENTRE.0) as f64 * SPACING_M;
    let d2 = dx * dx + dy * dy;
    let mut dip = WEAK_DEPTH * (-d2 / (2.0 * WEAK_SIGMA_M * WEAK_SIGMA_M)).exp();
    if (cell.row, cell.col) == WEAK_CENTRE {
        dip += WEAK_CENTRE_EXTRA;
    }
    let noise = 0.0028 * jitter(cell.row, cell.col, 7 + salt);
    (base + gradient + noise - dip * decline).clamp(0.05, 0.95)
}

/// Absolute flight grid: Mar 1 + k·28 d, keeping the newest `FLIGHT_COUNT` dates ≤ today.
fn flight_dates(today: NaiveDate) -> Vec<NaiveDate> {
    let year = if today.month() >= 3 {
        today.year()
    } else {
        today.year() - 1
    };
    let start = NaiveDate::from_ymd_opt(year, 3, 1).unwrap();
    let k_max = ((today - start).num_days() / FLIGHT_INTERVAL_DAYS).max(0);
    let k_min = (k_max - (FLIGHT_COUNT - 1)).max(0);
    (k_min..=k_max)
        .map(|k| start + Duration::days(k * FLIGHT_INTERVAL_DAYS))
        .collect()
}

async fn get_or_create_block(
    pool: &sqlx::PgPool,
    org_id: Uuid,
    parcel_id: Uuid,
    bounds: (f64, f64, f64, f64),
) -> anyhow::Result<Uuid> {
    let (w, s, e, n) = bounds;
    // `plant_blocks (parcel_id, lower(name))` is UNIQUE, so the name is the idempotency key —
    // the same one the GeoJSON/CSV import matches a `block` property against.
    let (id,) = sqlx::query_as::<_, (Uuid,)>(
        "INSERT INTO plant_blocks (org_id, parcel_id, name, geom, notes)
         VALUES ($1, $2, $3, ST_Multi(ST_MakeEnvelope($4, $5, $6, $7, 4326)), $8)
         ON CONFLICT (parcel_id, lower(name)) DO UPDATE
           SET geom = EXCLUDED.geom, notes = EXCLUDED.notes, updated_at = now()
         RETURNING id",
    )
    .bind(org_id)
    .bind(parcel_id)
    .bind(PLANT_BLOCK)
    .bind(w)
    .bind(s)
    .bind(e)
    .bind(n)
    .bind("Blocco dimostrativo: oliveto Coratina, sesto 6×6 m.")
    .fetch_one(pool)
    .await?;
    Ok(id)
}

async fn get_or_create_plant_row(
    pool: &sqlx::PgPool,
    org_id: Uuid,
    parcel_id: Uuid,
    block_id: Uuid,
    row_index: i32,
    line: (f64, f64, f64),
) -> anyhow::Result<Uuid> {
    let name = format!("Filare {row_index:02}");
    // Row names are not unique by schema (two blocks may both hold a "1"), so resolve by name
    // taking the lowest id — the same tie-break the import uses, which keeps re-runs stable.
    if let Some((id,)) = sqlx::query_as::<_, (Uuid,)>(
        "SELECT id FROM plant_rows WHERE parcel_id = $1 AND lower(name) = lower($2)
         ORDER BY id LIMIT 1",
    )
    .bind(parcel_id)
    .bind(&name)
    .fetch_optional(pool)
    .await?
    {
        return Ok(id);
    }
    let (w, e, lat) = line;
    let (id,) = sqlx::query_as::<_, (Uuid,)>(
        "INSERT INTO plant_rows (org_id, parcel_id, block_id, name, row_index, geom)
         VALUES ($1, $2, $3, $4, $5,
                 ST_SetSRID(ST_MakeLine(ST_MakePoint($6, $8), ST_MakePoint($7, $8)), 4326))
         RETURNING id",
    )
    .bind(org_id)
    .bind(parcel_id)
    .bind(block_id)
    .bind(&name)
    .bind(row_index)
    .bind(w)
    .bind(e)
    .bind(lat)
    .fetch_one(pool)
    .await?;
    Ok(id)
}

/// Bulk upsert of the whole grid in one statement, keyed on `external_ref` (the as-planted tag),
/// which is why `source = 'import'`: these trees come from the grower's map, and the demo flights
/// then observe them. Returns the ids aligned to `cells`.
async fn upsert_plants(
    pool: &sqlx::PgPool,
    org_id: Uuid,
    parcel_id: Uuid,
    block_id: Uuid,
    row_ids: &[Uuid],
    cells: &[GridCell],
) -> anyhow::Result<Vec<Uuid>> {
    let refs: Vec<String> = cells.iter().map(GridCell::external_ref).collect();
    let labels: Vec<String> = cells.iter().map(GridCell::label).collect();
    let rows: Vec<Uuid> = cells
        .iter()
        .map(|c| row_ids[(c.row - 1) as usize])
        .collect();
    let lons: Vec<f64> = cells.iter().map(|c| c.lon).collect();
    let lats: Vec<f64> = cells.iter().map(|c| c.lat).collect();
    let row_idx: Vec<i32> = cells.iter().map(|c| c.row).collect();
    let col_idx: Vec<i32> = cells.iter().map(|c| c.col).collect();
    let missing: Vec<bool> = cells.iter().map(|c| c.missing).collect();

    // `missing_streak = 2` is MISSING_AFTER_CAPTURES: the seed writes the terminal state
    // directly, because reaching it through the register stage needs two real flights.
    let out: Vec<(Uuid, String)> = sqlx::query_as(
        "INSERT INTO plants (org_id, parcel_id, block_id, row_id, unit_type, geom, label,
                             row_index, col_index, variety, planted_on, status, external_ref,
                             source, missing_streak)
         SELECT $1, $2, $3, u.row_id, 'tree'::plant_unit,
                ST_SetSRID(ST_MakePoint(u.lon, u.lat), 4326),
                u.label, u.row_index, u.col_index, 'Coratina', DATE '2011-11-15',
                CASE WHEN u.missing THEN 'missing'::plant_status ELSE 'alive'::plant_status END,
                u.external_ref, 'import',
                CASE WHEN u.missing THEN 2 ELSE 0 END
         FROM unnest($4::uuid[], $5::float8[], $6::float8[], $7::text[], $8::int4[], $9::int4[],
                     $10::text[], $11::bool[])
              AS u(row_id, lon, lat, label, row_index, col_index, external_ref, missing)
         ON CONFLICT (parcel_id, external_ref) WHERE external_ref IS NOT NULL DO UPDATE
           SET block_id = EXCLUDED.block_id, row_id = EXCLUDED.row_id, geom = EXCLUDED.geom,
               label = EXCLUDED.label, row_index = EXCLUDED.row_index,
               col_index = EXCLUDED.col_index, status = EXCLUDED.status,
               missing_streak = EXCLUDED.missing_streak, updated_at = now()
         RETURNING id, external_ref",
    )
    .bind(org_id)
    .bind(parcel_id)
    .bind(block_id)
    .bind(&rows)
    .bind(&lons)
    .bind(&lats)
    .bind(&labels)
    .bind(&row_idx)
    .bind(&col_idx)
    .bind(&refs)
    .bind(&missing)
    .fetch_all(pool)
    .await?;

    let by_ref: HashMap<String, Uuid> = out.into_iter().map(|(id, r)| (r, id)).collect();
    refs.iter()
        .map(|r| {
            by_ref
                .get(r)
                .copied()
                .ok_or_else(|| anyhow::anyhow!("plant {r} missing from the upsert result"))
        })
        .collect()
}

async fn get_or_create_capture(
    pool: &sqlx::PgPool,
    org_id: Uuid,
    parcel_id: Uuid,
    captured_at: chrono::DateTime<Utc>,
    author: Option<Uuid>,
) -> anyhow::Result<Uuid> {
    // `flight_ref` carries the date, so it is stable across re-seeds and readable in the UI.
    let flight_ref = format!("DEMO-{}", captured_at.date_naive().format("%Y%m%d"));
    if let Some((id,)) = sqlx::query_as::<_, (Uuid,)>(
        "SELECT id FROM captures WHERE parcel_id = $1 AND org_id = $2 AND flight_ref = $3",
    )
    .bind(parcel_id)
    .bind(org_id)
    .bind(&flight_ref)
    .fetch_optional(pool)
    .await?
    {
        return Ok(id);
    }
    // `source = 'demo'` is the CI/seed path: no GDAL, no assets, synthetic sampler.
    let (id,) = sqlx::query_as::<_, (Uuid,)>(
        "INSERT INTO captures (org_id, parcel_id, captured_at, source, status, unit_type, sensor,
                               gsd_cm, bands, pilot_name, drone_model, flight_ref, notes,
                               created_by, processed_at)
         VALUES ($1, $2, $3, 'demo', 'extracted', 'tree', 'MicaSense RedEdge-P', 2.5,
                 '{\"blue\":1,\"green\":2,\"red\":3,\"rededge\":4,\"nir\":5}'::jsonb,
                 'Demo Coltivatore', 'DJI Matrice 350 RTK', $4,
                 'Volo dimostrativo sul Blocco A (dati sintetici).', $5, $3)
         RETURNING id",
    )
    .bind(org_id)
    .bind(parcel_id)
    .bind(captured_at)
    .bind(&flight_ref)
    .bind(author)
    .fetch_one(pool)
    .await?;
    Ok(id)
}

/// One flight's per-plant metric values, as the column vectors the bulk insert unnests.
#[derive(Default)]
struct Samples {
    plant_ids: Vec<Uuid>,
    metrics: Vec<String>,
    values: Vec<f64>,
    quality: Vec<i16>,
}

impl Samples {
    fn push(&mut self, plant_id: Uuid, metric: &str, value: f64, quality: i16) {
        self.plant_ids.push(plant_id);
        self.metrics.push(metric.to_string());
        self.values.push(value);
        self.quality.push(quality);
    }
}

async fn write_samples(
    pool: &sqlx::PgPool,
    org_id: Uuid,
    parcel_id: Uuid,
    capture_id: Uuid,
    observed_at: chrono::DateTime<Utc>,
    s: &Samples,
) -> anyhow::Result<()> {
    // `observed_at = captures.captured_at` for every row, so the per-plant series aligns with
    // the flights (docs/API-PLANT.md §Extraction) — and it is the PK, so a re-run overwrites.
    sqlx::query(
        "INSERT INTO plant_observations
           (plant_id, capture_id, org_id, parcel_id, metric, observed_at, value, quality, model_ver)
         SELECT u.plant_id, $1, $2, $3, u.metric, $4, u.value, u.quality, $5
         FROM unnest($6::uuid[], $7::text[], $8::float8[], $9::int2[])
              AS u(plant_id, metric, value, quality)
         ON CONFLICT (plant_id, metric, observed_at) DO UPDATE
           SET capture_id = EXCLUDED.capture_id, value = EXCLUDED.value,
               quality = EXCLUDED.quality, model_ver = EXCLUDED.model_ver",
    )
    .bind(capture_id)
    .bind(org_id)
    .bind(parcel_id)
    .bind(observed_at)
    .bind(PLANT_MODEL_VER)
    .bind(&s.plant_ids)
    .bind(&s.metrics)
    .bind(&s.values)
    .bind(&s.quality)
    .execute(pool)
    .await?;
    Ok(())
}

/// The tail of the `extract` stage (FR-P-032): the per-plant values rolled up into the parcel's
/// `index_observations` with `source = 'drone'`, which is the seam that keeps the Tier-0
/// dashboard, series API and season report working over drone data with no changes.
/// The Tier-0 anomaly detector reads `sentinel-2` or `demo` rows only, so these never disturb it.
///
/// The statistics must match `worker::rollup` (and therefore `arvo_core::indices::stats`, what
/// `imagery/worker.rs` writes for Sentinel-2) exactly, so that a drone point and a satellite point
/// on the same chart mean the same thing and re-running `arvo-worker` over a seeded capture is a
/// no-op: linear-interpolation percentiles (`percentile_cont`) and **population** stddev
/// (`stddev_pop`, which is what `stats` computes — it divides by count, not count − 1).
async fn rollup_capture(
    pool: &sqlx::PgPool,
    parcel_id: Uuid,
    capture_id: Uuid,
) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT INTO index_observations
           (parcel_id, index_name, observed_at, mean, median, p10, p90, stddev,
            pixel_count, cloud_pct, source)
         SELECT $1, o.metric, o.observed_at, avg(o.value),
                percentile_cont(0.5) WITHIN GROUP (ORDER BY o.value),
                percentile_cont(0.1) WITHIN GROUP (ORDER BY o.value),
                percentile_cont(0.9) WITHIN GROUP (ORDER BY o.value),
                coalesce(stddev_pop(o.value), 0), count(*), 0, 'drone'
         FROM plant_observations o
         JOIN plants p ON p.id = o.plant_id AND p.status <> 'removed'
         WHERE o.capture_id = $2 AND o.parcel_id = $1
           AND o.metric IN ('ndvi', 'ndre', 'gndvi', 'ndmi', 'savi')
         GROUP BY o.metric, o.observed_at
         ON CONFLICT (parcel_id, index_name, observed_at) DO UPDATE
           SET mean = EXCLUDED.mean, median = EXCLUDED.median, p10 = EXCLUDED.p10,
               p90 = EXCLUDED.p90, stddev = EXCLUDED.stddev,
               pixel_count = EXCLUDED.pixel_count, cloud_pct = EXCLUDED.cloud_pct,
               source = EXCLUDED.source",
    )
    .bind(parcel_id)
    .bind(capture_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Counters + footprint, computed from what the flight actually produced.
async fn finish_capture(
    pool: &sqlx::PgPool,
    org_id: Uuid,
    capture_id: Uuid,
    bounds: (f64, f64, f64, f64),
) -> anyhow::Result<()> {
    let (w, s, e, n) = bounds;
    sqlx::query(
        "UPDATE captures c SET
           status = 'extracted',
           bbox = ST_MakeEnvelope($3, $4, $5, $6, 4326),
           plant_count = (SELECT count(DISTINCT o.plant_id) FROM plant_observations o
                          WHERE o.capture_id = c.id),
           observation_count = (SELECT count(*) FROM plant_observations o
                                WHERE o.capture_id = c.id),
           processed_at = c.captured_at,
           failed_stage = NULL, error = NULL, updated_at = now()
         WHERE c.id = $1 AND c.org_id = $2",
    )
    .bind(capture_id)
    .bind(org_id)
    .bind(w)
    .bind(s)
    .bind(e)
    .bind(n)
    .execute(pool)
    .await?;
    Ok(())
}

#[derive(sqlx::FromRow)]
struct SeedNeighbourRow {
    plant_id: Uuid,
    label: Option<String>,
    value: f64,
    neighbours: Vec<f64>,
}

/// `POST /alerts/detect/plants` semantics for `plant_vigor_outlier`, applied to the newest
/// flight: neighbours are the k nearest alive plants within `radius_m` (PostGIS KNN), the
/// verdict is `core::plant_anomaly` — the same pure function the endpoint calls, on the same
/// dedupe key, so re-running the real detector refines these rows instead of duplicating them.
/// Returns how many alerts the seeded field actually produced.
async fn seed_plant_outlier_alerts(
    state: &AppState,
    org_id: Uuid,
    parcel_id: Uuid,
    capture_id: Uuid,
    date: NaiveDate,
) -> anyhow::Result<usize> {
    let pool = &state.pool;
    let rows: Vec<SeedNeighbourRow> = sqlx::query_as(
        "SELECT p.id AS plant_id, p.label, o.value,
                ARRAY(
                    SELECT o2.value
                    FROM plants n
                    JOIN plant_observations o2
                      ON o2.plant_id = n.id AND o2.capture_id = $3 AND o2.metric = 'ndvi'
                    WHERE n.parcel_id = p.parcel_id AND n.org_id = p.org_id
                      AND n.id <> p.id AND n.status = 'alive'
                      AND ST_DWithin(n.geom::geography, p.geom::geography, $4)
                    ORDER BY n.geom <-> p.geom
                    LIMIT $5
                ) AS neighbours
         FROM plants p
         JOIN plant_observations o
           ON o.plant_id = p.id AND o.capture_id = $3 AND o.metric = 'ndvi'
         WHERE p.parcel_id = $1 AND p.org_id = $2 AND p.status = 'alive'",
    )
    .bind(parcel_id)
    .bind(org_id)
    .bind(capture_id)
    .bind(pa::DEFAULT_RADIUS_M)
    .bind(pa::DEFAULT_K as i64)
    .fetch_all(pool)
    .await?;

    let mut created = 0usize;
    for r in &rows {
        let Some(o) = pa::evaluate(r.value, &r.neighbours, pa::DEFAULT_THRESHOLD_Z) else {
            continue;
        };
        let name = r.label.clone().unwrap_or_else(|| r.plant_id.to_string());
        let message = format!(
            "{name}: NDVI {:.2} contro {:.2} delle {} piante più vicine (scarto robusto z {:.1}). \
             Le piante intorno stanno bene, quindi conviene un sopralluogo mirato.",
            r.value, o.neighbour_median, o.neighbour_count, o.z
        );
        upsert_seed_plant_alert(
            pool,
            org_id,
            parcel_id,
            r.plant_id,
            "plant_vigor_outlier",
            o.severity.as_str(),
            "Pianta più debole delle vicine",
            &message,
            json!({
                "metric": "ndvi", "value": r.value,
                "neighbour_median": o.neighbour_median, "neighbour_mad": o.neighbour_mad,
                "z": o.z, "capture_id": capture_id, "model_ver": PLANT_MODEL_VER,
            }),
            &format!("plant_vigor_outlier:{}:{}", r.plant_id, date),
        )
        .await?;
        created += 1;
    }
    Ok(created)
}

/// `plant_missing` for every gap the register stage has given up on — same kind, severity and
/// dedupe key as the detector, so the demo tenant shows a plant alert without calling it.
async fn seed_missing_plant_alerts(
    pool: &sqlx::PgPool,
    org_id: Uuid,
    parcel_id: Uuid,
) -> anyhow::Result<()> {
    let gone: Vec<(Uuid, Option<String>, i32)> = sqlx::query_as(
        "SELECT id, label, missing_streak FROM plants
         WHERE parcel_id = $1 AND org_id = $2 AND status = 'missing'",
    )
    .bind(parcel_id)
    .bind(org_id)
    .fetch_all(pool)
    .await?;
    for (plant_id, label, streak) in gone {
        let name = label.unwrap_or_else(|| plant_id.to_string());
        let message = format!(
            "{name}: nessuna chioma rilevata negli ultimi {streak} voli. \
             Verificare in campo se la pianta è da reimpiantare."
        );
        upsert_seed_plant_alert(
            pool,
            org_id,
            parcel_id,
            plant_id,
            "plant_missing",
            "warning",
            "Pianta non rilevata",
            &message,
            json!({ "metric": null, "value": null, "status": "missing", "captures_absent": streak }),
            &format!("plant_missing:{plant_id}"),
        )
        .await?;
    }
    Ok(())
}

/// Same upsert as `plant_insights::upsert_plant_alert`: refreshes the copy but never touches
/// `state`, so an alert the demo user acked or dismissed is not resurrected by a re-seed.
#[allow(clippy::too_many_arguments)]
async fn upsert_seed_plant_alert(
    pool: &sqlx::PgPool,
    org_id: Uuid,
    parcel_id: Uuid,
    plant_id: Uuid,
    kind: &str,
    severity: &str,
    title: &str,
    message: &str,
    data: serde_json::Value,
    dedupe_key: &str,
) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT INTO alerts (org_id, parcel_id, plant_id, kind, severity, title, message,
                             data, dedupe_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO UPDATE
           SET severity = EXCLUDED.severity, title = EXCLUDED.title,
               message = EXCLUDED.message, data = EXCLUDED.data, updated_at = now()",
    )
    .bind(org_id)
    .bind(parcel_id)
    .bind(plant_id)
    .bind(kind)
    .bind(severity)
    .bind(title)
    .bind(message)
    .bind(data)
    .bind(dedupe_key)
    .execute(pool)
    .await?;
    Ok(())
}

/// A scouting note pinned to the failing tree (FR-P-060) — the deterministic id dedupes it on
/// the primary key, exactly like the Tier-0 demo observations.
async fn seed_plant_note(
    pool: &sqlx::PgPool,
    org_id: Uuid,
    parcel_id: Uuid,
    plant_id: Uuid,
    author_id: Uuid,
    cell: &GridCell,
) -> anyhow::Result<()> {
    let taken_at = Utc.from_utc_datetime(
        &(Utc::now().date_naive() - Duration::days(2))
            .and_hms_opt(8, 15, 0)
            .unwrap(),
    );
    let tags: Vec<String> = vec!["pianta".into(), "vigore".into()];
    sqlx::query(
        "INSERT INTO observations
           (id, org_id, parcel_id, plant_id, author_id, lon, lat, note, tags, photos,
            taken_at, deleted, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'[]'::jsonb,$10,false,$10)
         ON CONFLICT (id) DO NOTHING",
    )
    .bind(Uuid::from_u128(PLANT_NOTE_ID))
    .bind(org_id)
    .bind(parcel_id)
    .bind(plant_id)
    .bind(author_id)
    .bind(cell.lon)
    .bind(cell.lat)
    .bind(format!(
        "Pianta {}: chioma rada e rami secchi, molto peggio delle vicine. Controllare l'ala gocciolante.",
        cell.label()
    ))
    .bind(&tags)
    .bind(taken_at)
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cell(row: i32, col: i32) -> GridCell {
        GridCell {
            row,
            col,
            lon: 0.0,
            lat: 0.0,
            missing: false,
        }
    }

    /// Interior flight dates must not move as the season advances: a later re-seed adds a
    /// capture, it does not shift the dates whose observations are already stored.
    #[test]
    fn flight_dates_are_a_stable_absolute_grid() {
        let july = flight_dates(NaiveDate::from_ymd_opt(2026, 7, 20).unwrap());
        let august = flight_dates(NaiveDate::from_ymd_opt(2026, 8, 20).unwrap());
        assert_eq!(july.len(), FLIGHT_COUNT as usize);
        for w in july.windows(2) {
            assert_eq!((w[1] - w[0]).num_days(), FLIGHT_INTERVAL_DAYS);
        }
        assert!(august.contains(&july[1]) && august.contains(&july[2]));
        // Early in the season there is simply less history — never a flight in the future.
        assert_eq!(
            flight_dates(NaiveDate::from_ymd_opt(2026, 3, 20).unwrap()),
            vec![NaiveDate::from_ymd_opt(2026, 3, 1).unwrap()]
        );
    }

    /// The healthy field is planar: every tree sits at the mean of its row neighbours, up to the
    /// wobble. That is what keeps the neighbour detector quiet everywhere except the patch — a
    /// bumpy or noisy field makes it (correctly) alert on healthy trees, and the demo drowns.
    #[test]
    fn healthy_field_is_planar_within_the_wobble() {
        for col in 2..GRID_COLS {
            let v = demo_ndvi(&cell(2, col), 0.6, 1.0, 0);
            let mean = (demo_ndvi(&cell(2, col - 1), 0.6, 1.0, 0)
                + demo_ndvi(&cell(2, col + 1), 0.6, 1.0, 0))
                / 2.0;
            assert!((v - mean).abs() < 0.006, "col {col}: {v} vs mean {mean}");
        }
    }

    /// …and the two things the seed exists to plant: a tree far below its neighbours (what the
    /// neighbour detector must find) whose own series declines (what the temporal one sees).
    #[test]
    fn the_failing_tree_stands_out_and_declines() {
        let (r, c) = WEAK_CENTRE;
        let centre = demo_ndvi(&cell(r, c), 0.6, 1.0, 0);
        for (dr, dc) in [(0, -1), (0, 1), (-1, 0), (1, 0)] {
            let n = demo_ndvi(&cell(r + dr, c + dc), 0.6, 1.0, 0);
            assert!(
                n - centre > 0.2,
                "neighbour {n} is not above centre {centre}"
            );
        }
        let first_flight = demo_ndvi(&cell(r, c), 0.4, 1.0 / 3.0, 0);
        assert!(
            first_flight > centre,
            "the patch must deepen across flights"
        );
    }

    #[test]
    fn the_grid_has_exactly_one_gap() {
        let cells = grid_cells(15.858, 41.448);
        assert_eq!(cells.len(), (GRID_ROWS * GRID_COLS) as usize);
        assert_eq!(cells.iter().filter(|c| c.missing).count(), 1);
        assert_eq!(cells[0].label(), "R01-P01");
        assert_eq!(cells[0].external_ref(), "UV-A-R01-P01");
    }
}
