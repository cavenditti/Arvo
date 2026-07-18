//! OWNER: be-weather — weather ingest (Open-Meteo) + agronomic models per docs/API.md §Weather.
//! `router()` is the only public entry (mounted in routes.rs under /api/v1).
use std::collections::BTreeMap;

use axum::extract::{Path, Query, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Datelike, Days, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use arvo_core::agro::{self, Advisory, AdvisoryKind, ForecastDay, Severity};

use crate::audit;
use crate::error::{ApiError, ApiResult};
use crate::security::{AuthUser, Role};
use crate::state::AppState;
use crate::util::{resolve_lang, Lang};

const FORECAST_URL: &str = "https://api.open-meteo.com/v1/forecast";
const ARCHIVE_URL: &str = "https://archive-api.open-meteo.com/v1/archive";
const DAILY_VARS: &str = "temperature_2m_max,temperature_2m_min,temperature_2m_mean,precipitation_sum,relative_humidity_2m_mean,wind_speed_10m_max,shortwave_radiation_sum,et0_fao_evapotranspiration";
const STALE_HOURS: i64 = 6;
const ARCHIVE_DAYS: u64 = 120;
const FORECAST_DAYS: u64 = 7;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/parcels/{id}/weather", get(get_weather))
        .route("/parcels/{id}/weather/refresh", post(refresh))
        .route("/parcels/{id}/agro", get(get_agro))
        .route("/parcels/{id}/advisories", get(get_advisories))
}

// ---------- shared parcel lookup ----------

#[derive(Debug, sqlx::FromRow)]
struct ParcelInfo {
    lon: f64,
    lat: f64,
    crop: Option<String>,
    planting_date: Option<NaiveDate>,
    season_year: Option<i32>,
}

/// Org-scoped parcel fetch with centroid. Cross-tenant / missing → NotFound.
async fn parcel_info(state: &AppState, org_id: Uuid, id: Uuid) -> ApiResult<ParcelInfo> {
    sqlx::query_as::<_, ParcelInfo>(
        "SELECT ST_X(ST_Centroid(geom)) AS lon, ST_Y(ST_Centroid(geom)) AS lat,
                crop, planting_date, season_year
         FROM parcels WHERE id = $1 AND org_id = $2",
    )
    .bind(id)
    .bind(org_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(ApiError::NotFound)
}

// ---------- Open-Meteo client ----------

#[derive(Debug, Deserialize)]
struct OmResponse {
    daily: Option<OmDaily>,
}

#[derive(Debug, Default, Deserialize)]
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

#[derive(Debug, Clone)]
struct DayRow {
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

impl DayRow {
    /// Fill this row's missing fields from `o` (used when observed + forecast overlap).
    fn fill_from(&mut self, o: &DayRow) {
        self.t_min = self.t_min.or(o.t_min);
        self.t_max = self.t_max.or(o.t_max);
        self.t_mean = self.t_mean.or(o.t_mean);
        self.precip_mm = self.precip_mm.or(o.precip_mm);
        self.humidity_mean = self.humidity_mean.or(o.humidity_mean);
        self.wind_max_kmh = self.wind_max_kmh.or(o.wind_max_kmh);
        self.radiation_mj = self.radiation_mj.or(o.radiation_mj);
        self.et0_mm = self.et0_mm.or(o.et0_mm);
    }
}

async fn fetch_daily(
    client: &reqwest::Client,
    url: &str,
    params: &[(&str, String)],
) -> anyhow::Result<OmDaily> {
    let resp = client
        .get(url)
        .query(params)
        .send()
        .await?
        .error_for_status()?;
    let body: OmResponse = resp.json().await?;
    body.daily
        .ok_or_else(|| anyhow::anyhow!("open-meteo returned no daily block"))
}

/// Merge an Open-Meteo daily block into `out`, keyed by date. `is_forecast` is decided
/// purely by date (>= today), independent of which endpoint delivered the row; existing
/// (observed) values are preferred and only their gaps are filled.
fn merge(daily: &OmDaily, today: NaiveDate, out: &mut BTreeMap<NaiveDate, DayRow>) {
    for (i, t) in daily.time.iter().enumerate() {
        let Ok(date) = NaiveDate::parse_from_str(t, "%Y-%m-%d") else {
            continue;
        };
        let row = DayRow {
            date,
            t_min: daily.temperature_2m_min.get(i).copied().flatten(),
            t_max: daily.temperature_2m_max.get(i).copied().flatten(),
            t_mean: daily.temperature_2m_mean.get(i).copied().flatten(),
            precip_mm: daily.precipitation_sum.get(i).copied().flatten(),
            humidity_mean: daily.relative_humidity_2m_mean.get(i).copied().flatten(),
            wind_max_kmh: daily.wind_speed_10m_max.get(i).copied().flatten(),
            radiation_mj: daily.shortwave_radiation_sum.get(i).copied().flatten(),
            et0_mm: daily.et0_fao_evapotranspiration.get(i).copied().flatten(),
            is_forecast: date >= today,
        };
        out.entry(date)
            .and_modify(|e| e.fill_from(&row))
            .or_insert(row);
    }
}

/// Fetch archive (past) + forecast (future) and upsert into weather_daily.
/// Network failures are swallowed (warn + serve/return what we have); only DB errors
/// propagate. Returns the number of daily rows written.
///
/// Single-flight: the whole refresh runs inside one transaction holding a per-parcel
/// advisory lock, so N concurrent dashboard reads on a stale parcel trigger one
/// Open-Meteo round-trip, not N. Losers return 0 and serve the cached rows.
async fn refresh_weather(state: &AppState, parcel_id: Uuid, info: &ParcelInfo) -> ApiResult<i64> {
    let today = Utc::now().date_naive();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| ApiError::Internal(e.into()))?;

    let mut tx = state.pool.begin().await?;
    let got_lock: bool =
        sqlx::query_scalar("SELECT pg_try_advisory_xact_lock(hashtext('weather:' || $1::text))")
            .bind(parcel_id)
            .fetch_one(&mut *tx)
            .await?;
    if !got_lock {
        return Ok(0); // another request is already refreshing this parcel
    }

    // Archive window: last 120 days, extended back to planting_date if that is older.
    let mut start = today - Days::new(ARCHIVE_DAYS);
    if let Some(p) = info.planting_date {
        if p < start {
            start = p;
        }
    }
    let archive_end = today - Days::new(1);

    let mut rows: BTreeMap<NaiveDate, DayRow> = BTreeMap::new();

    // Archive first so real observations win; forecast (with past_days) only fills gaps
    // and supplies the future.
    if start <= archive_end {
        let params = [
            ("latitude", info.lat.to_string()),
            ("longitude", info.lon.to_string()),
            ("daily", DAILY_VARS.to_string()),
            ("timezone", "auto".to_string()),
            ("start_date", start.to_string()),
            ("end_date", archive_end.to_string()),
        ];
        match fetch_daily(&client, ARCHIVE_URL, &params).await {
            Ok(d) => merge(&d, today, &mut rows),
            Err(e) => {
                tracing::warn!(error = ?e, parcel_id = %parcel_id, "open-meteo archive fetch failed")
            }
        }
    }

    let params = [
        ("latitude", info.lat.to_string()),
        ("longitude", info.lon.to_string()),
        ("daily", DAILY_VARS.to_string()),
        ("timezone", "auto".to_string()),
        ("past_days", "7".to_string()),
        ("forecast_days", FORECAST_DAYS.to_string()),
    ];
    match fetch_daily(&client, FORECAST_URL, &params).await {
        Ok(d) => merge(&d, today, &mut rows),
        Err(e) => {
            tracing::warn!(error = ?e, parcel_id = %parcel_id, "open-meteo forecast fetch failed")
        }
    }

    if rows.is_empty() {
        return Ok(0);
    }

    for r in rows.values() {
        sqlx::query(
            "INSERT INTO weather_daily
               (parcel_id, date, t_min, t_max, t_mean, precip_mm, humidity_mean,
                wind_max_kmh, radiation_mj, et0_mm, is_forecast, fetched_at, source)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now(), 'open-meteo')
             ON CONFLICT (parcel_id, date) DO UPDATE SET
               t_min = EXCLUDED.t_min, t_max = EXCLUDED.t_max, t_mean = EXCLUDED.t_mean,
               precip_mm = EXCLUDED.precip_mm, humidity_mean = EXCLUDED.humidity_mean,
               wind_max_kmh = EXCLUDED.wind_max_kmh, radiation_mj = EXCLUDED.radiation_mj,
               et0_mm = EXCLUDED.et0_mm, is_forecast = EXCLUDED.is_forecast,
               fetched_at = now(), source = EXCLUDED.source",
        )
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
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

    Ok(rows.len() as i64)
}

/// Lazy staleness refresh: refresh when there is no observed row or the newest observed
/// row was fetched more than STALE_HOURS ago. Tolerant of network failure (warn only).
async fn ensure_fresh(state: &AppState, parcel_id: Uuid, info: &ParcelInfo) {
    let newest: Option<DateTime<Utc>> = match sqlx::query_scalar(
        "SELECT max(fetched_at) FROM weather_daily WHERE parcel_id = $1 AND NOT is_forecast",
    )
    .bind(parcel_id)
    .fetch_one(&state.pool)
    .await
    {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(error = ?e, "weather staleness check failed");
            return;
        }
    };
    let stale = match newest {
        None => true,
        Some(ts) => Utc::now() - ts > chrono::Duration::hours(STALE_HOURS),
    };
    if stale {
        if let Err(e) = refresh_weather(state, parcel_id, info).await {
            tracing::warn!(error = ?e, parcel_id = %parcel_id, "weather refresh failed; serving cached");
        }
    }
}

// ---------- GET /parcels/{id}/weather ----------

#[derive(Debug, Deserialize)]
struct WeatherQuery {
    from: Option<NaiveDate>,
    to: Option<NaiveDate>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
struct WeatherDaily {
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

async fn get_weather(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Query(q): Query<WeatherQuery>,
) -> ApiResult<Json<Value>> {
    let info = parcel_info(&state, user.org_id, id).await?;
    ensure_fresh(&state, id, &info).await;

    let today = Utc::now().date_naive();
    let from = q.from.unwrap_or_else(|| today - Days::new(30));
    let to = q.to.unwrap_or_else(|| today + Days::new(7));

    let daily = sqlx::query_as::<_, WeatherDaily>(
        "SELECT date, t_min, t_max, t_mean, precip_mm, humidity_mean, wind_max_kmh,
                radiation_mj, et0_mm, is_forecast
         FROM weather_daily
         WHERE parcel_id = $1 AND date >= $2 AND date <= $3
         ORDER BY date",
    )
    .bind(id)
    .bind(from)
    .bind(to)
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(json!({ "daily": daily })))
}

// ---------- POST /parcels/{id}/weather/refresh ----------

async fn refresh(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    user.require(Role::Operator)?;
    let info = parcel_info(&state, user.org_id, id).await?;
    let days_written = refresh_weather(&state, id, &info).await?;
    audit::record(
        &state.pool,
        user.org_id,
        Some(user.user_id),
        "weather.refresh",
        "parcel",
        id,
        json!({ "days_written": days_written }),
    )
    .await;
    Ok(Json(json!({ "days_written": days_written })))
}

// ---------- GET /parcels/{id}/agro ----------

#[derive(Debug, sqlx::FromRow)]
struct AgroRow {
    date: NaiveDate,
    t_min: Option<f64>,
    t_max: Option<f64>,
    precip_mm: Option<f64>,
    et0_mm: Option<f64>,
}

async fn get_agro(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Query(q): Query<LangQuery>,
) -> ApiResult<Json<Value>> {
    let info = parcel_info(&state, user.org_id, id).await?;
    ensure_fresh(&state, id, &info).await;
    let lang = resolve_lang(&state, user.user_id, q.lang).await;

    let today = Utc::now().date_naive();
    let base = agro::base_temp(info.crop.as_deref());
    let from_date = info.planting_date.unwrap_or_else(|| {
        let year = info.season_year.unwrap_or_else(|| today.year());
        NaiveDate::from_ymd_opt(year, 3, 1).unwrap_or(today)
    });

    // Pull every row we might need (GDD window and the 30-day balance window), observed
    // rows only: today's row is a forecast until the archive backfills it, and forecast
    // temps/precip must not leak into the accumulations.
    let window_start = from_date.min(today - Days::new(30));
    let rows = sqlx::query_as::<_, AgroRow>(
        "SELECT date, t_min, t_max, precip_mm, et0_mm
         FROM weather_daily
         WHERE parcel_id = $1 AND date >= $2 AND date <= $3 AND is_forecast = false
         ORDER BY date",
    )
    .bind(id)
    .bind(window_start)
    .bind(today)
    .fetch_all(&state.pool)
    .await?;

    // GDD from from_date onward, over days with both temperatures present.
    let gdd_pairs: Vec<(f64, f64)> = rows
        .iter()
        .filter(|r| r.date >= from_date)
        .filter_map(|r| Some((r.t_min?, r.t_max?)))
        .collect();
    let gdd = agro::gdd_sum(&gdd_pairs, base);

    // Aligned precip/ET0 arrays over the last 30 days for the water balance.
    let bal_start = today - Days::new(30);
    let bal: Vec<&AgroRow> = rows.iter().filter(|r| r.date > bal_start).collect();
    let precip: Vec<f64> = bal.iter().map(|r| r.precip_mm.unwrap_or(0.0)).collect();
    let et0: Vec<f64> = bal.iter().map(|r| r.et0_mm.unwrap_or(0.0)).collect();

    let wb7 = agro::water_balance(&precip, &et0, 7);
    let wb30 = agro::water_balance(&precip, &et0, 30);
    let precip_7d: f64 = precip.iter().rev().take(7).sum();
    let et0_7d: f64 = et0.iter().rev().take(7).sum();

    let notes = agro_notes(lang, &from_date, base, gdd, precip_7d, et0_7d, wb7);

    Ok(Json(json!({
        "gdd": { "sum": round1(gdd), "base_temp": base, "from_date": from_date },
        "et0_7d_mm": round1(et0_7d),
        "precip_7d_mm": round1(precip_7d),
        "water_balance_7d_mm": round1(wb7),
        "water_balance_30d_mm": round1(wb30),
        "notes": notes,
    })))
}

// ---------- GET /parcels/{id}/advisories ----------

async fn get_advisories(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Query(q): Query<LangQuery>,
) -> ApiResult<Json<Value>> {
    let info = parcel_info(&state, user.org_id, id).await?;
    ensure_fresh(&state, id, &info).await;
    let lang = resolve_lang(&state, user.user_id, q.lang).await;

    // `date >= CURRENT_DATE`: when refresh has failed for days, stale forecast rows for
    // dates already gone must not produce advisories about the past.
    let days = sqlx::query_as::<_, ForecastRow>(
        "SELECT date, t_min, t_max, precip_mm, wind_max_kmh
         FROM weather_daily
         WHERE parcel_id = $1 AND is_forecast = true AND date >= CURRENT_DATE
         ORDER BY date",
    )
    .bind(id)
    .fetch_all(&state.pool)
    .await?;

    let forecast: Vec<ForecastDay> = days
        .iter()
        .map(|r| ForecastDay {
            date: r.date,
            t_min: r.t_min,
            t_max: r.t_max,
            precip_mm: r.precip_mm,
            wind_max_kmh: r.wind_max_kmh,
        })
        .collect();

    let advisories = agro::advisories(&forecast);

    // Persist critical frost/heat advisories as deduped alerts (best-effort).
    for a in &advisories {
        if a.severity == Severity::Critical
            && matches!(a.kind, AdvisoryKind::FrostRisk | AdvisoryKind::HeatStress)
        {
            upsert_alert(&state, user.org_id, user.user_id, id, a, lang).await;
        }
    }

    let out: Vec<Value> = advisories
        .iter()
        .map(|a| {
            json!({
                "kind": a.kind.as_str(),
                "severity": a.severity.as_str(),
                "date": a.date,
                "message": advisory_message(lang, a),
            })
        })
        .collect();

    Ok(Json(json!(out)))
}

#[derive(Debug, sqlx::FromRow)]
struct ForecastRow {
    date: NaiveDate,
    t_min: Option<f64>,
    t_max: Option<f64>,
    precip_mm: Option<f64>,
    wind_max_kmh: Option<f64>,
}

/// Upsert one critical advisory into `alerts`, deduped on `kind:parcel:date`.
async fn upsert_alert(
    state: &AppState,
    org_id: Uuid,
    user_id: Uuid,
    parcel_id: Uuid,
    a: &Advisory,
    lang: Lang,
) {
    let dedupe_key = format!("{}:{}:{}", a.kind.as_str(), parcel_id, a.date);
    let title = alert_title(lang, a);
    let message = advisory_message(lang, a);
    let data = json!({ "date": a.date, "value": a.value, "source": "advisory" });

    let res = sqlx::query(
        "INSERT INTO alerts (org_id, parcel_id, kind, severity, title, message, data, dedupe_key)
         VALUES ($1,$2,$3,'critical',$4,$5,$6,$7)
         ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING",
    )
    .bind(org_id)
    .bind(parcel_id)
    .bind(a.kind.as_str())
    .bind(&title)
    .bind(&message)
    .bind(&data)
    .bind(&dedupe_key)
    .execute(&state.pool)
    .await;

    match res {
        Ok(r) if r.rows_affected() > 0 => {
            audit::record(
                &state.pool,
                org_id,
                Some(user_id),
                "alert.create",
                "alert",
                &dedupe_key,
                json!({ "kind": a.kind.as_str(), "parcel_id": parcel_id, "date": a.date }),
            )
            .await;
        }
        Ok(_) => {} // already existed
        Err(e) => tracing::warn!(error = ?e, "advisory alert upsert failed"),
    }
}

// ---------- localization ----------

#[derive(Debug, Deserialize)]
struct LangQuery {
    lang: Option<String>,
}

fn round1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

fn advisory_message(lang: Lang, a: &Advisory) -> String {
    let t = a.value.unwrap_or(0.0);
    let date = a.date;
    match (a.kind, a.severity, lang) {
        (AdvisoryKind::FrostRisk, Severity::Critical, Lang::It) => format!(
            "Gelo intenso previsto il {date}: minima {t:.1}°C. Alto rischio di danni; valutare misure di protezione."
        ),
        (AdvisoryKind::FrostRisk, Severity::Critical, Lang::En) => format!(
            "Hard frost expected on {date}: low of {t:.1}°C. High damage risk; consider protective measures."
        ),
        (AdvisoryKind::FrostRisk, _, Lang::It) => format!(
            "Rischio di gelo il {date}: minima prevista {t:.1}°C. Proteggere le colture sensibili."
        ),
        (AdvisoryKind::FrostRisk, _, Lang::En) => format!(
            "Frost risk on {date}: forecast low of {t:.1}°C. Protect sensitive crops."
        ),
        (AdvisoryKind::HeatStress, Severity::Critical, Lang::It) => format!(
            "Caldo estremo il {date}: massima {t:.1}°C. Elevato stress idrico; valutare l'irrigazione."
        ),
        (AdvisoryKind::HeatStress, Severity::Critical, Lang::En) => format!(
            "Extreme heat on {date}: high of {t:.1}°C. High water stress; consider irrigation."
        ),
        (AdvisoryKind::HeatStress, _, Lang::It) => format!(
            "Stress da caldo il {date}: massima {t:.1}°C. Monitorare lo stato idrico della coltura."
        ),
        (AdvisoryKind::HeatStress, _, Lang::En) => format!(
            "Heat stress on {date}: high of {t:.1}°C. Monitor crop water status."
        ),
        (AdvisoryKind::SprayWindow, _, Lang::It) => format!(
            "Finestra favorevole ai trattamenti il {date}: vento debole e assenza di pioggia."
        ),
        (AdvisoryKind::SprayWindow, _, Lang::En) => format!(
            "Favorable spraying window on {date}: light wind and no rain."
        ),
    }
}

fn alert_title(lang: Lang, a: &Advisory) -> String {
    match (a.kind, lang) {
        (AdvisoryKind::FrostRisk, Lang::It) => "Gelo intenso".into(),
        (AdvisoryKind::FrostRisk, Lang::En) => "Hard frost".into(),
        (AdvisoryKind::HeatStress, Lang::It) => "Caldo estremo".into(),
        (AdvisoryKind::HeatStress, Lang::En) => "Extreme heat".into(),
        (AdvisoryKind::SprayWindow, Lang::It) => "Finestra trattamenti".into(),
        (AdvisoryKind::SprayWindow, Lang::En) => "Spraying window".into(),
    }
}

#[allow(clippy::too_many_arguments)]
fn agro_notes(
    lang: Lang,
    from_date: &NaiveDate,
    base: f64,
    gdd: f64,
    precip_7d: f64,
    et0_7d: f64,
    wb7: f64,
) -> Vec<String> {
    let mut notes = Vec::new();
    match lang {
        Lang::It => {
            notes.push(format!(
                "Sommatoria termica: {:.0} GDD dal {} (base {:.0}°C).",
                gdd, from_date, base
            ));
            notes.push(format!(
                "Ultimi 7 giorni: pioggia {:.1} mm, ET0 {:.1} mm.",
                precip_7d, et0_7d
            ));
            if wb7 < 0.0 {
                notes.push(format!(
                    "Bilancio idrico settimanale negativo ({:.1} mm): possibile deficit, valutare l'irrigazione.",
                    wb7
                ));
            } else {
                notes.push(format!(
                    "Bilancio idrico settimanale positivo ({:.1} mm): riserva idrica adeguata.",
                    wb7
                ));
            }
        }
        Lang::En => {
            notes.push(format!(
                "Growing degree days: {:.0} GDD since {} (base {:.0}°C).",
                gdd, from_date, base
            ));
            notes.push(format!(
                "Last 7 days: rainfall {:.1} mm, ET0 {:.1} mm.",
                precip_7d, et0_7d
            ));
            if wb7 < 0.0 {
                notes.push(format!(
                    "Weekly water balance negative ({:.1} mm): possible deficit, consider irrigation.",
                    wb7
                ));
            } else {
                notes.push(format!(
                    "Weekly water balance positive ({:.1} mm): adequate soil moisture.",
                    wb7
                ));
            }
        }
    }
    notes
}
