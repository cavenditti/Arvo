//! Minimal fixed-window per-IP rate limiter for the unauthenticated auth endpoints:
//! argon2 hashing is deliberately CPU-heavy and `/auth/register` creates orgs, so both need
//! a brake against credential stuffing and spam. In-process by design (single-binary MVP);
//! when deploying behind a reverse proxy make sure real client IPs reach the app
//! (or terminate rate limiting at the proxy and raise these caps).
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::extract::connect_info::ConnectInfo;
use axum::extract::Request;
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

const WINDOW: Duration = Duration::from_secs(60);
const MAX_PER_WINDOW: u32 = 30;
/// Opportunistic GC threshold: beyond this many tracked IPs, expired windows are swept.
const GC_THRESHOLD: usize = 10_000;

static BUCKETS: OnceLock<Mutex<HashMap<IpAddr, (Instant, u32)>>> = OnceLock::new();

fn over_limit(ip: IpAddr) -> bool {
    let now = Instant::now();
    let mut map = BUCKETS
        .get_or_init(Default::default)
        .lock()
        .expect("ratelimit lock");
    if map.len() > GC_THRESHOLD {
        map.retain(|_, (start, _)| now.duration_since(*start) < WINDOW);
    }
    let entry = map.entry(ip).or_insert((now, 0));
    if now.duration_since(entry.0) >= WINDOW {
        *entry = (now, 0);
    }
    entry.1 += 1;
    entry.1 > MAX_PER_WINDOW
}

pub async fn auth_rate_limit(req: Request, next: Next) -> Response {
    // ConnectInfo is absent when the router is driven without a TCP listener (tests);
    // degrade open rather than fail every auth request in that case.
    let ip = req
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ci| ci.0.ip());
    if let Some(ip) = ip {
        if over_limit(ip) {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                Json(json!({ "error": { "code": "rate_limited", "message": "too many requests, retry later" } })),
            )
                .into_response();
        }
    }
    next.run(req).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_caps_then_resets() {
        let ip: IpAddr = "192.0.2.7".parse().unwrap();
        for _ in 0..MAX_PER_WINDOW {
            assert!(!over_limit(ip));
        }
        assert!(over_limit(ip));
    }
}
