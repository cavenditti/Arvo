// SPINE (read-only for feature agents). JWT claims, role lattice, AuthUser extractor.
// Swapping to OIDC later touches only this module (PHASE0 §4).
use axum::extract::{FromRef, FromRequestParts};
use axum::http::request::Parts;
use chrono::Utc;
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
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
pub struct Claims {
    pub sub: Uuid,
    pub org: Uuid,
    pub role: Role,
    pub exp: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aud: Option<String>,
}

pub fn issue_token(jwt_secret: &str, user_id: Uuid, org_id: Uuid, role: Role) -> ApiResult<String> {
    let claims = Claims {
        sub: user_id,
        org: org_id,
        role,
        exp: (Utc::now() + chrono::Duration::days(7)).timestamp(),
        aud: None,
    };
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(jwt_secret.as_bytes()),
    )
    .map_err(|e| ApiError::Internal(e.into()))
}

/// Mint a media token for the caller. Returns `(token, exp_unix_seconds)`.
pub fn issue_media_token(jwt_secret: &str, user: &AuthUser) -> ApiResult<(String, i64)> {
    let exp = (Utc::now() + chrono::Duration::minutes(MEDIA_TOKEN_TTL_MINUTES)).timestamp();
    let claims = Claims {
        sub: user.user_id,
        org: user.org_id,
        role: user.role,
        exp,
        aud: Some(MEDIA_AUDIENCE.into()),
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

fn decode_claims(jwt_secret: &str, token: &str) -> ApiResult<Claims> {
    // `aud` is enforced manually below (session vs media), not by jsonwebtoken.
    let mut validation = Validation::new(Algorithm::HS256);
    validation.validate_aud = false;
    decode::<Claims>(
        token,
        &DecodingKey::from_secret(jwt_secret.as_bytes()),
        &validation,
    )
    .map(|d| d.claims)
    .map_err(|_| ApiError::Unauthorized)
}

fn auth_user(claims: Claims) -> AuthUser {
    AuthUser {
        user_id: claims.sub,
        org_id: claims.org,
        role: claims.role,
    }
}

/// Validate a full *session* JWT (Bearer header). Media tokens are rejected here so a token
/// leaked from a tile/photo URL cannot call the API proper.
pub fn decode_token(jwt_secret: &str, token: &str) -> ApiResult<AuthUser> {
    let claims = decode_claims(jwt_secret, token)?;
    if claims.aud.is_some() {
        return Err(ApiError::Unauthorized);
    }
    Ok(auth_user(claims))
}

/// Validate a short-lived *media* JWT (`?token=` on tiles, GeoTIFF and photo URLs — raster
/// `<img>` clients cannot set an `Authorization` header, docs/API.md §"Media tokens").
/// Session tokens are rejected so long-lived credentials never ride in query strings.
pub fn decode_media_token(jwt_secret: &str, token: &str) -> ApiResult<AuthUser> {
    let claims = decode_claims(jwt_secret, token)?;
    if claims.aud.as_deref() != Some(MEDIA_AUDIENCE) {
        return Err(ApiError::Unauthorized);
    }
    Ok(auth_user(claims))
}

/// Bearer session token (header) or short-lived media token (`?token=`). The shared guard
/// for every endpoint that browsers/`<img>` clients open directly: photos, tiles, GeoTIFF,
/// season report. Session tokens never ride in query strings; media tokens can't call the
/// rest of the API.
pub fn authenticate_bearer_or_media(
    jwt_secret: &str,
    headers: &axum::http::HeaderMap,
    query_token: Option<&str>,
) -> ApiResult<AuthUser> {
    if let Some(token) = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
    {
        return decode_token(jwt_secret, token);
    }
    let token = query_token.ok_or(ApiError::Unauthorized)?;
    decode_media_token(jwt_secret, token)
}

/// Hex SHA-256, used to store invite tokens at rest without keeping the secret itself.
pub fn sha256_hex(input: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(input.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
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
        decode_token(&app.cfg.jwt_secret, token)
    }
}
