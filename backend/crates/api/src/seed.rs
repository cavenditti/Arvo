//! OWNER: integrate-backend — demo tenant seed (`arvo-api seed --demo`, docs/AGENTS.md §Seed spec).
//! Idempotent: re-running produces no duplicates (users/org/farm/parcels keyed by email/name,
//! weather + index series + observations upsert on their natural keys). Uses `imagery::synth`
//! for the index series and runs the anomaly detector (via `jobs`) at the end.
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

use crate::imagery::synth;
use crate::jobs;
use crate::state::AppState;

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
    let org_id = get_or_create_org(pool, "Azienda Agricola Demo").await?;
    let demo_user = get_or_create_user(
        pool,
        "demo@arvo.local",
        "demo1234",
        "Demo Coltivatore",
        "it",
    )
    .await?;
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
