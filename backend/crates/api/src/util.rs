//! Small cross-module helpers (validation, language resolution).
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

/// Reject unreasonably long user-supplied strings before they round-trip through
/// every list/report. `max` is in bytes (all caps are far above any legit UTF-8 input).
pub fn require_len(field: &str, value: &str, max: usize) -> ApiResult<()> {
    if value.len() > max {
        return Err(ApiError::BadRequest(format!(
            "{field} too long (max {max} chars)"
        )));
    }
    Ok(())
}

/// The two UI languages. Italian-first per FR-0-072.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    It,
    En,
}

/// "en", "en-GB", "EN_us" → En; everything else → It.
pub fn parse_lang(s: &str) -> Lang {
    if s.trim().to_ascii_lowercase().starts_with("en") {
        Lang::En
    } else {
        Lang::It
    }
}

/// `?lang=it|en` wins; otherwise fall back to the user's stored locale; default Italian.
pub async fn resolve_lang(state: &AppState, user_id: Uuid, q: Option<String>) -> Lang {
    if let Some(l) = q {
        return parse_lang(&l);
    }
    let locale: Option<String> = sqlx::query_scalar("SELECT locale FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(&state.pool)
        .await
        .ok()
        .flatten();
    locale.map(|l| parse_lang(&l)).unwrap_or(Lang::It)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caps_reject_over_limit() {
        assert!(require_len("name", &"x".repeat(10), 10).is_ok());
        assert!(require_len("name", &"x".repeat(11), 10).is_err());
    }

    #[test]
    fn lang_parsing() {
        assert_eq!(parse_lang("it"), Lang::It);
        assert_eq!(parse_lang("EN"), Lang::En);
        assert_eq!(parse_lang("en-GB"), Lang::En);
        assert_eq!(parse_lang(" en_US"), Lang::En);
        assert_eq!(parse_lang("fr"), Lang::It);
        assert_eq!(parse_lang(""), Lang::It);
    }
}
