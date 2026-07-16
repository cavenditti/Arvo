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

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: Uuid,
    pub org: Uuid,
    pub role: Role,
    pub exp: i64,
}

pub fn issue_token(jwt_secret: &str, user_id: Uuid, org_id: Uuid, role: Role) -> ApiResult<String> {
    let claims = Claims {
        sub: user_id,
        org: org_id,
        role,
        exp: (Utc::now() + chrono::Duration::days(7)).timestamp(),
    };
    encode(&Header::default(), &claims, &EncodingKey::from_secret(jwt_secret.as_bytes()))
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

/// Validate a raw JWT string and return the authenticated caller. Shared by the `AuthUser`
/// extractor (Bearer header) and the tile/GeoTIFF endpoints, which also accept a `?token=`
/// query param because raster `<img>` clients cannot set an `Authorization` header (docs/API.md
/// §"Raster tiles & GeoTIFF export"). Same claims decode either way, so org scoping is identical.
pub fn decode_token(jwt_secret: &str, token: &str) -> ApiResult<AuthUser> {
    let data = decode::<Claims>(
        token,
        &DecodingKey::from_secret(jwt_secret.as_bytes()),
        &Validation::new(Algorithm::HS256),
    )
    .map_err(|_| ApiError::Unauthorized)?;
    Ok(AuthUser {
        user_id: data.claims.sub,
        org_id: data.claims.org,
        role: data.claims.role,
    })
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
