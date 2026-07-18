//! OWNER: be-scouting — per-season parcel report per docs/API.md §Reports & export.
//! Self-contained, print-optimised HTML (inline CSS/SVG; external refs only for /uploads thumbs).
use std::fmt::Write as _;

use axum::extract::{Path, Query, State};
use axum::response::Html;
use axum::routing::get;
use axum::Router;
use chrono::{DateTime, Datelike, NaiveDate, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::audit;
use crate::error::{ApiError, ApiResult};
use crate::security::{authenticate_bearer_or_media, issue_media_token};
use crate::state::AppState;
use crate::util;

pub fn router() -> Router<AppState> {
    Router::new().route("/reports/parcels/{id}/season", get(season_report))
}

#[derive(Debug, sqlx::FromRow)]
struct ParcelHeader {
    name: String,
    crop: Option<String>,
    variety: Option<String>,
    season_year: Option<i32>,
    planting_date: Option<NaiveDate>,
    farm_name: String,
    area_ha: Option<f64>,
}

#[derive(Debug, sqlx::FromRow)]
struct SeriesPoint {
    observed_at: DateTime<Utc>,
    mean: f64,
}

#[derive(Debug, sqlx::FromRow)]
struct WeatherSummary {
    precip_sum: f64,
    et0_sum: f64,
    gdd_sum: f64,
}

#[derive(Debug, sqlx::FromRow)]
struct AlertRow {
    created_at: DateTime<Utc>,
    kind: String,
    severity: String,
    message: String,
    state: String,
}

#[derive(Debug, sqlx::FromRow)]
struct ScoutRow {
    taken_at: DateTime<Utc>,
    note: String,
    tags: Vec<String>,
    photos: Value,
}

#[derive(Debug, Deserialize)]
struct ReportQuery {
    lang: Option<String>,
    /// Short-lived media token — lets the app open the report in a plain browser tab
    /// (docs/API.md §"Media tokens") without ever putting the session JWT in a URL.
    token: Option<String>,
}

/// GET /reports/parcels/{id}/season?lang=it|en → print-friendly HTML.
/// Auth: Bearer session token or `?token=` media token.
async fn season_report(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<Uuid>,
    Query(q): Query<ReportQuery>,
) -> ApiResult<Html<String>> {
    let user = authenticate_bearer_or_media(&state.cfg.jwt_secret, &headers, q.token.as_deref())?;
    let lang = match util::resolve_lang(&state, user.user_id, q.lang).await {
        util::Lang::En => "en",
        util::Lang::It => "it",
    };
    let t = labels(lang);
    // Photo thumbnails are behind the authenticated /uploads route; a short-lived media
    // token keeps them loading in the print view without putting the session JWT in HTML.
    let (media_token, _) = issue_media_token(&state.cfg.jwt_secret, &user)?;

    let header: ParcelHeader = sqlx::query_as(
        "SELECT p.name, p.crop, p.variety, p.season_year, p.planting_date,
                f.name AS farm_name, ST_Area(p.geom::geography) / 10000.0 AS area_ha
         FROM parcels p JOIN farms f ON f.id = p.farm_id
         WHERE p.id = $1 AND p.org_id = $2",
    )
    .bind(id)
    .bind(user.org_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(ApiError::NotFound)?;

    let ndvi: Vec<SeriesPoint> = sqlx::query_as(
        "SELECT observed_at, mean FROM index_observations
         WHERE parcel_id = $1 AND index_name = 'ndvi'
         ORDER BY observed_at ASC",
    )
    .bind(id)
    .fetch_all(&state.pool)
    .await?;

    // Accumulation window: planting date, else Mar 1 of the season year.
    let start = header.planting_date.unwrap_or_else(|| {
        let year = header.season_year.unwrap_or_else(|| Utc::now().year());
        NaiveDate::from_ymd_opt(year, 3, 1).unwrap_or_else(|| Utc::now().date_naive())
    });

    // GDD base 10 °C approximation: Σ max(0, (tmin+tmax)/2 − 10).
    let wx: WeatherSummary = sqlx::query_as(
        "SELECT COALESCE(SUM(precip_mm), 0) AS precip_sum,
                COALESCE(SUM(et0_mm), 0) AS et0_sum,
                COALESCE(SUM(GREATEST(0, (t_min + t_max) / 2.0 - 10.0)), 0) AS gdd_sum
         FROM weather_daily WHERE parcel_id = $1 AND date >= $2",
    )
    .bind(id)
    .bind(start)
    .fetch_one(&state.pool)
    .await?;

    let alerts: Vec<AlertRow> = sqlx::query_as(
        "SELECT created_at, kind, severity, message, state::text AS state
         FROM alerts WHERE org_id = $1 AND parcel_id = $2
         ORDER BY created_at DESC",
    )
    .bind(user.org_id)
    .bind(id)
    .fetch_all(&state.pool)
    .await?;

    let scouting: Vec<ScoutRow> = sqlx::query_as(
        "SELECT taken_at, note, tags, photos FROM observations
         WHERE org_id = $1 AND parcel_id = $2 AND deleted = false
         ORDER BY taken_at DESC",
    )
    .bind(user.org_id)
    .bind(id)
    .fetch_all(&state.pool)
    .await?;

    let html = render(
        &t,
        lang,
        &header,
        start,
        &ndvi,
        &wx,
        &alerts,
        &scouting,
        &media_token,
    );

    audit::record(
        &state.pool,
        user.org_id,
        Some(user.user_id),
        "report.render",
        "parcel",
        id,
        json!({ "report": "season", "lang": lang }),
    )
    .await;

    Ok(Html(html))
}

/// Localised section labels (tiny inline match on lang; Italian is primary).
struct L {
    title: &'static str,
    farm: &'static str,
    crop: &'static str,
    variety: &'static str,
    area: &'static str,
    season: &'static str,
    planted: &'static str,
    ndvi: &'static str,
    weather: &'static str,
    precip: &'static str,
    et0: &'static str,
    gdd: &'static str,
    since: &'static str,
    alerts: &'static str,
    col_date: &'static str,
    col_kind: &'static str,
    col_sev: &'static str,
    col_msg: &'static str,
    col_state: &'static str,
    scouting: &'static str,
    col_note: &'static str,
    col_tags: &'static str,
    none: &'static str,
    disclaimer: &'static str,
    generated: &'static str,
}

fn labels(lang: &str) -> L {
    if lang == "en" {
        L {
            title: "Season report",
            farm: "Farm",
            crop: "Crop",
            variety: "Variety",
            area: "Area",
            season: "Season",
            planted: "Planted",
            ndvi: "NDVI trend",
            weather: "Weather summary",
            precip: "Precipitation",
            et0: "Reference ET\u{2080}",
            gdd: "Growing degree days (base 10 \u{00B0}C)",
            since: "since",
            alerts: "Alerts",
            col_date: "Date",
            col_kind: "Type",
            col_sev: "Severity",
            col_msg: "Message",
            col_state: "State",
            scouting: "Scouting log",
            col_note: "Note",
            col_tags: "Tags",
            none: "No data",
            disclaimer: "The information provided is decision support and does not constitute an agronomic prescription.",
            generated: "Generated on",
        }
    } else {
        L {
            title: "Report stagionale",
            farm: "Azienda",
            crop: "Coltura",
            variety: "Variet\u{00E0}",
            area: "Superficie",
            season: "Stagione",
            planted: "Impianto",
            ndvi: "Andamento NDVI",
            weather: "Riepilogo meteo",
            precip: "Precipitazioni",
            et0: "ET\u{2080} di riferimento",
            gdd: "Gradi giorno (base 10 \u{00B0}C)",
            since: "dal",
            alerts: "Avvisi",
            col_date: "Data",
            col_kind: "Tipo",
            col_sev: "Severit\u{00E0}",
            col_msg: "Messaggio",
            col_state: "Stato",
            scouting: "Diario di scouting",
            col_note: "Nota",
            col_tags: "Tag",
            none: "Nessun dato",
            disclaimer: "Le indicazioni fornite sono di supporto alle decisioni e non costituiscono prescrizione agronomica.",
            generated: "Generato il",
        }
    }
}

const STYLE: &str = "<style>\
*{box-sizing:border-box}\
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a2b1f;margin:0;padding:32px;background:#fff}\
.wrap{max-width:900px;margin:0 auto}\
header.rpt{border-bottom:3px solid #2f7d3a;padding-bottom:16px;margin-bottom:8px}\
header.rpt h1{margin:0 0 4px;font-size:26px;color:#1f5c29}\
header.rpt .sub{color:#5a6b5e;font-size:14px}\
.meta{display:flex;flex-wrap:wrap;gap:8px 28px;margin-top:12px;font-size:14px}\
.meta div span{color:#6b7a6e;margin-right:6px}\
.meta div b{color:#1a2b1f;font-weight:600}\
section{margin:28px 0;page-break-inside:avoid}\
section h2{font-size:17px;color:#1f5c29;border-bottom:1px solid #d8e2d9;padding-bottom:6px;margin:0 0 14px}\
section h2 .note{font-weight:400;font-size:13px;color:#8a978c}\
.chips{display:flex;flex-wrap:wrap;gap:12px}\
.chip{background:#f1f6f0;border:1px solid #d8e2d9;border-radius:8px;padding:10px 16px;min-width:120px}\
.chip .k{display:block;font-size:12px;color:#6b7a6e}\
.chip .v{font-size:20px;font-weight:700;color:#1f5c29}\
table{width:100%;border-collapse:collapse;font-size:13px}\
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid #e6ece6;vertical-align:top}\
th{background:#f1f6f0;color:#3a4b3e;font-weight:600}\
.sev-critical{color:#b3261e;font-weight:700}\
.sev-warning{color:#b25f00;font-weight:600}\
.sev-info{color:#3a4b3e}\
.thumbs{display:flex;gap:6px;margin-top:6px}\
.thumbs img{height:64px;width:64px;object-fit:cover;border-radius:6px;border:1px solid #d8e2d9}\
.tags{color:#4a7d52;font-size:12px}\
.empty{color:#8a978c;font-style:italic}\
footer.rpt{margin-top:40px;border-top:1px solid #d8e2d9;padding-top:16px;font-size:12px;color:#6b7a6e}\
footer.rpt .disc{background:#fff8e6;border:1px solid #f0e0a8;border-radius:8px;padding:12px 14px;color:#6b5a1e;margin-bottom:10px}\
svg{max-width:100%;height:auto}\
@media print{body{padding:0}.chip,th{-webkit-print-color-adjust:exact;print-color-adjust:exact}}\
</style>";

#[allow(clippy::too_many_arguments)]
fn render(
    t: &L,
    lang: &str,
    h: &ParcelHeader,
    start: NaiveDate,
    ndvi: &[SeriesPoint],
    wx: &WeatherSummary,
    alerts: &[AlertRow],
    scouting: &[ScoutRow],
    media_token: &str,
) -> String {
    let mut s = String::with_capacity(8192);
    s.push_str("<!doctype html><html lang=\"");
    s.push_str(lang);
    s.push_str("\"><head><meta charset=\"utf-8\">");
    s.push_str("<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>");
    s.push_str(&esc(&h.name));
    s.push_str(" \u{2014} ");
    s.push_str(t.title);
    s.push_str("</title>");
    s.push_str(STYLE);
    s.push_str("</head><body><div class=\"wrap\">");

    // Header
    s.push_str("<header class=\"rpt\"><h1>");
    s.push_str(&esc(&h.name));
    s.push_str("</h1><div class=\"sub\">");
    s.push_str(t.title);
    s.push_str("</div><div class=\"meta\">");
    meta(&mut s, t.farm, &esc(&h.farm_name));
    if let Some(c) = &h.crop {
        meta(&mut s, t.crop, &esc(c));
    }
    if let Some(v) = &h.variety {
        meta(&mut s, t.variety, &esc(v));
    }
    if let Some(a) = h.area_ha {
        meta(&mut s, t.area, &format!("{a:.2} ha"));
    }
    if let Some(y) = h.season_year {
        meta(&mut s, t.season, &y.to_string());
    }
    if let Some(pd) = h.planting_date {
        meta(&mut s, t.planted, &pd.to_string());
    }
    s.push_str("</div></header>");

    // NDVI
    s.push_str("<section><h2>");
    s.push_str(t.ndvi);
    s.push_str("</h2>");
    if ndvi.is_empty() {
        empty(&mut s, t.none);
    } else {
        s.push_str(&ndvi_svg(ndvi));
    }
    s.push_str("</section>");

    // Weather
    s.push_str("<section><h2>");
    s.push_str(t.weather);
    let _ = write!(
        s,
        " <span class=\"note\">({} {start})</span></h2><div class=\"chips\">",
        t.since
    );
    chip(&mut s, t.precip, &format!("{:.0} mm", wx.precip_sum));
    chip(&mut s, t.et0, &format!("{:.0} mm", wx.et0_sum));
    chip(&mut s, t.gdd, &format!("{:.0} \u{00B0}Cd", wx.gdd_sum));
    s.push_str("</div></section>");

    // Alerts
    s.push_str("<section><h2>");
    s.push_str(t.alerts);
    s.push_str("</h2>");
    if alerts.is_empty() {
        empty(&mut s, t.none);
    } else {
        s.push_str("<table><thead><tr>");
        for c in [t.col_date, t.col_kind, t.col_sev, t.col_msg, t.col_state] {
            let _ = write!(s, "<th>{c}</th>");
        }
        s.push_str("</tr></thead><tbody>");
        for a in alerts {
            let sev = match a.severity.as_str() {
                "critical" => "sev-critical",
                "warning" => "sev-warning",
                _ => "sev-info",
            };
            let _ = write!(
                s,
                "<tr><td>{}</td><td>{}</td><td class=\"{sev}\">{}</td><td>{}</td><td>{}</td></tr>",
                a.created_at.format("%Y-%m-%d"),
                esc(&a.kind),
                esc(&a.severity),
                esc(&a.message),
                esc(&a.state),
            );
        }
        s.push_str("</tbody></table>");
    }
    s.push_str("</section>");

    // Scouting log
    s.push_str("<section><h2>");
    s.push_str(t.scouting);
    s.push_str("</h2>");
    if scouting.is_empty() {
        empty(&mut s, t.none);
    } else {
        s.push_str("<table><thead><tr>");
        for c in [t.col_date, t.col_note, t.col_tags] {
            let _ = write!(s, "<th>{c}</th>");
        }
        s.push_str("</tr></thead><tbody>");
        for o in scouting {
            let _ = write!(
                s,
                "<tr><td style=\"white-space:nowrap\">{}</td><td>{}",
                o.taken_at.format("%Y-%m-%d"),
                esc(&o.note),
            );
            // Only server-issued upload paths become <img> tags (photos are also sanitized
            // at write time; this is defense in depth against a report fetching foreign URLs).
            let thumbs: Vec<&str> = o
                .photos
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .filter_map(|p| p.get("path").and_then(Value::as_str))
                        .filter(|p| p.starts_with("/uploads/") && !p.contains(".."))
                        .take(3)
                        .collect()
                })
                .unwrap_or_default();
            if !thumbs.is_empty() {
                s.push_str("<div class=\"thumbs\">");
                for p in thumbs {
                    let _ = write!(
                        s,
                        "<img src=\"{}?token={}\" alt=\"\">",
                        esc(p),
                        esc(media_token)
                    );
                }
                s.push_str("</div>");
            }
            let _ = write!(
                s,
                "</td><td class=\"tags\">{}</td></tr>",
                esc(&o.tags.join(", "))
            );
        }
        s.push_str("</tbody></table>");
    }
    s.push_str("</section>");

    // Footer — mandatory decision-support disclaimer + generation timestamp.
    s.push_str("<footer class=\"rpt\"><div class=\"disc\">");
    s.push_str(t.disclaimer);
    let _ = write!(
        s,
        "</div><div>{} {}</div></footer></div></body></html>",
        t.generated,
        Utc::now().format("%Y-%m-%d %H:%M UTC"),
    );
    s
}

fn meta(s: &mut String, k: &str, v: &str) {
    let _ = write!(s, "<div><span>{k}</span><b>{v}</b></div>");
}

fn chip(s: &mut String, k: &str, v: &str) {
    let _ = write!(
        s,
        "<div class=\"chip\"><span class=\"k\">{k}</span><span class=\"v\">{v}</span></div>"
    );
}

fn empty(s: &mut String, msg: &str) {
    let _ = write!(s, "<p class=\"empty\">{msg}</p>");
}

/// NDVI polyline chart: date x-axis, 0..1 y-axis, inline SVG.
fn ndvi_svg(pts: &[SeriesPoint]) -> String {
    let (w, h) = (860.0_f64, 260.0_f64);
    let (ml, mr, mt, mb) = (44.0_f64, 16.0_f64, 16.0_f64, 34.0_f64);
    let pw = w - ml - mr;
    let ph = h - mt - mb;
    let t0 = pts.first().unwrap().observed_at.timestamp() as f64;
    let t1 = pts.last().unwrap().observed_at.timestamp() as f64;
    let span = (t1 - t0).max(1.0);
    let x = |ts: f64| ml + (ts - t0) / span * pw;
    let y = |v: f64| mt + (1.0 - v.clamp(0.0, 1.0)) * ph;

    let mut s = String::with_capacity(2048);
    let _ = write!(
        s,
        "<svg viewBox=\"0 0 {w} {h}\" xmlns=\"http://www.w3.org/2000/svg\" role=\"img\">"
    );
    let _ = write!(s, "<rect x=\"{ml}\" y=\"{mt}\" width=\"{pw}\" height=\"{ph}\" fill=\"#f7faf6\" stroke=\"#d8e2d9\"/>");

    // y gridlines + labels (0, 0.25, 0.5, 0.75, 1.0)
    for i in 0..=4 {
        let v = i as f64 * 0.25;
        let yy = y(v);
        let _ = write!(
            s,
            "<line x1=\"{ml}\" y1=\"{yy:.1}\" x2=\"{:.1}\" y2=\"{yy:.1}\" stroke=\"#e6ece6\"/>",
            ml + pw
        );
        let _ = write!(s, "<text x=\"{:.1}\" y=\"{:.1}\" font-size=\"11\" fill=\"#6b7a6e\" text-anchor=\"end\">{v:.2}</text>", ml - 6.0, yy + 3.0);
    }

    // x ticks + date labels
    let ticks = 4;
    for i in 0..=ticks {
        let f = i as f64 / ticks as f64;
        let ts = t0 + f * span;
        let xx = x(ts);
        let _ = write!(
            s,
            "<line x1=\"{xx:.1}\" y1=\"{:.1}\" x2=\"{xx:.1}\" y2=\"{:.1}\" stroke=\"#d8e2d9\"/>",
            mt + ph,
            mt + ph + 4.0
        );
        let dt = DateTime::<Utc>::from_timestamp(ts as i64, 0).unwrap_or_else(Utc::now);
        let _ = write!(s, "<text x=\"{xx:.1}\" y=\"{:.1}\" font-size=\"11\" fill=\"#6b7a6e\" text-anchor=\"middle\">{}</text>", mt + ph + 18.0, dt.format("%d/%m"));
    }

    // polyline + points
    let mut poly = String::new();
    for p in pts {
        let _ = write!(
            poly,
            "{:.1},{:.1} ",
            x(p.observed_at.timestamp() as f64),
            y(p.mean)
        );
    }
    let _ = write!(
        s,
        "<polyline points=\"{}\" fill=\"none\" stroke=\"#2f7d3a\" stroke-width=\"2.5\"/>",
        poly.trim()
    );
    for p in pts {
        let _ = write!(
            s,
            "<circle cx=\"{:.1}\" cy=\"{:.1}\" r=\"3\" fill=\"#1f5c29\"/>",
            x(p.observed_at.timestamp() as f64),
            y(p.mean)
        );
    }
    s.push_str("</svg>");
    s
}

/// Minimal HTML escaping for text and attribute contexts.
fn esc(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for c in input.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}
