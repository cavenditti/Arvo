// Better Auth JWT verification, media-token signing, role lattice and AuthUser extractor.
use axum::extract::{FromRef, FromRequestParts};
use axum::http::request::Parts;
use chrono::Utc;
use jsonwebtoken::jwk::{Jwk, JwkSet};
use jsonwebtoken::{
    decode, decode_header, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation,
};
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

/// Ordered lattice: viewer < operator < agronomist < admin < owner.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, sqlx::Type,
)]
#[sqlx(type_name = "org_role", rename_all = "lowercase")]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Viewer,
    Operator,
    Agronomist,
    Admin,
    Owner,
}

/// Audience of the short-lived, read-only tokens minted for raster tiles and photo URLs
/// (`<img>`/tile clients cannot set an `Authorization` header, so these ride in `?token=`).
/// Session tokens carry no `aud`; media tokens carry `aud = "media"` and a short expiry, so a
/// token leaked via an access log or referrer cannot call the API proper.
pub const MEDIA_AUDIENCE: &str = "media";
pub const MEDIA_TOKEN_TTL_MINUTES: i64 = 15;

#[derive(Debug, Serialize, Deserialize)]
struct BetterAuthClaims {
    pub sub: Uuid,
    pub org: Uuid,
    pub role: Role,
    pub exp: i64,
    pub iss: String,
    pub aud: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize)]
struct MediaClaims {
    pub sub: Uuid,
    pub org: Uuid,
    pub role: Role,
    pub exp: i64,
    pub aud: String,
}

/// Mint a media token for the caller. Returns `(token, exp_unix_seconds)`.
pub fn issue_media_token(jwt_secret: &str, user: &AuthUser) -> ApiResult<(String, i64)> {
    let exp = (Utc::now() + chrono::Duration::minutes(MEDIA_TOKEN_TTL_MINUTES)).timestamp();
    let claims = MediaClaims {
        sub: user.user_id,
        org: user.org_id,
        role: user.role,
        exp,
        aud: MEDIA_AUDIENCE.into(),
    };
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(jwt_secret.as_bytes()),
    )
    .map(|t| (t, exp))
    .map_err(|e| ApiError::Internal(e.into()))
}

/// Authenticated caller. `org_id` ALWAYS comes from here, never from request bodies.
#[derive(Debug, Clone, Copy)]
pub struct AuthUser {
    pub user_id: Uuid,
    pub org_id: Uuid,
    pub role: Role,
}

impl AuthUser {
    pub fn require(&self, min: Role) -> Result<(), ApiError> {
        if self.role >= min {
            Ok(())
        } else {
            Err(ApiError::Forbidden)
        }
    }
}

fn auth_user(user_id: Uuid, org_id: Uuid, role: Role) -> AuthUser {
    AuthUser {
        user_id,
        org_id,
        role,
    }
}

const JWKS_CACHE_TTL: Duration = Duration::from_secs(60 * 60);

#[derive(Default)]
pub struct JwksCache {
    set: Option<JwkSet>,
    fetched_at: Option<Instant>,
}

impl JwksCache {
    fn fresh_key(&self, kid: &str) -> Option<Jwk> {
        let fresh = self
            .fetched_at
            .is_some_and(|fetched| fetched.elapsed() < JWKS_CACHE_TTL);
        fresh
            .then(|| self.set.as_ref()?.find(kid).cloned())
            .flatten()
    }

    fn any_key(&self, kid: &str) -> Option<Jwk> {
        self.set.as_ref()?.find(kid).cloned()
    }
}

async fn verification_key(state: &AppState, kid: &str) -> ApiResult<Jwk> {
    if let Some(key) = state.jwks.read().await.fresh_key(kid) {
        return Ok(key);
    }

    let mut cache = state.jwks.write().await;
    if let Some(key) = cache.fresh_key(kid) {
        return Ok(key);
    }

    let fetched = reqwest::Client::new()
        .get(&state.cfg.better_auth_jwks_url)
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .and_then(|response| response.error_for_status());

    match fetched {
        Ok(response) => match response.json::<JwkSet>().await {
            Ok(set) => {
                let key = set.find(kid).cloned().ok_or(ApiError::Unauthorized)?;
                cache.set = Some(set);
                cache.fetched_at = Some(Instant::now());
                Ok(key)
            }
            Err(error) => {
                tracing::warn!(%error, "Better Auth JWKS response was invalid");
                cache.any_key(kid).ok_or(ApiError::Unauthorized)
            }
        },
        Err(error) => {
            // A transient auth-service outage should not invalidate tokens whose signing key we
            // have already seen. Unknown key IDs still fail closed.
            tracing::warn!(%error, "could not refresh Better Auth JWKS; using cached key");
            cache.any_key(kid).ok_or(ApiError::Unauthorized)
        }
    }
}

/// Validate a Better Auth JWT from the Bearer header using its rotating public JWKS. Issuer,
/// audience, expiry, algorithm, signature, user UUID, organization UUID and role are all checked.
pub async fn decode_token(state: &AppState, token: &str) -> ApiResult<AuthUser> {
    let header = decode_header(token).map_err(|_| ApiError::Unauthorized)?;
    if header.alg != Algorithm::EdDSA {
        return Err(ApiError::Unauthorized);
    }
    let kid = header.kid.ok_or(ApiError::Unauthorized)?;
    let jwk = verification_key(state, &kid).await?;
    let key = DecodingKey::from_jwk(&jwk).map_err(|_| ApiError::Unauthorized)?;
    let mut validation = Validation::new(Algorithm::EdDSA);
    validation.set_issuer(&[state.cfg.better_auth_issuer.as_str()]);
    validation.set_audience(&[state.cfg.better_auth_audience.as_str()]);
    validation.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);
    validation.leeway = 15;
    let claims = decode::<BetterAuthClaims>(token, &key, &validation)
        .map_err(|_| ApiError::Unauthorized)?
        .claims;
    Ok(auth_user(claims.sub, claims.org, claims.role))
}

/// Validate a short-lived *media* JWT (`?token=` on tiles, GeoTIFF and photo URLs — raster
/// `<img>` clients cannot set an `Authorization` header, docs/API.md §"Media tokens").
/// Session tokens are rejected so long-lived credentials never ride in query strings.
pub fn decode_media_token(jwt_secret: &str, token: &str) -> ApiResult<AuthUser> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.set_audience(&[MEDIA_AUDIENCE]);
    let claims = decode::<MediaClaims>(
        token,
        &DecodingKey::from_secret(jwt_secret.as_bytes()),
        &validation,
    )
    .map_err(|_| ApiError::Unauthorized)?
    .claims;
    Ok(auth_user(claims.sub, claims.org, claims.role))
}

/// Bearer session token (header) or short-lived media token (`?token=`). The shared guard
/// for every endpoint that browsers/`<img>` clients open directly: photos, tiles, GeoTIFF,
/// season report. Session tokens never ride in query strings; media tokens can't call the
/// rest of the API.
pub async fn authenticate_bearer_or_media(
    state: &AppState,
    headers: &axum::http::HeaderMap,
    query_token: Option<&str>,
) -> ApiResult<AuthUser> {
    if let Some(token) = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
    {
        return decode_token(state, token).await;
    }
    let token = query_token.ok_or(ApiError::Unauthorized)?;
    decode_media_token(&state.cfg.jwt_secret, token)
}

impl<S> FromRequestParts<S> for AuthUser
where
    AppState: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let app = AppState::from_ref(state);
        let token = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .ok_or(ApiError::Unauthorized)?;
        decode_token(&app, token).await
    }
}
