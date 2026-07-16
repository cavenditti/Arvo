// SPINE (read-only for feature agents). Best-effort append-only audit trail (FR-0-004).
use uuid::Uuid;

pub async fn record(
    pool: &sqlx::PgPool,
    org_id: Uuid,
    user_id: Option<Uuid>,
    action: &str,
    entity: &str,
    entity_id: impl ToString,
    data: serde_json::Value,
) {
    if let Err(e) = sqlx::query(
        "INSERT INTO audit_log (org_id, user_id, action, entity, entity_id, data)
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(org_id)
    .bind(user_id)
    .bind(action)
    .bind(entity)
    .bind(entity_id.to_string())
    .bind(data)
    .execute(pool)
    .await
    {
        tracing::warn!(error = ?e, action, "audit insert failed");
    }
}
