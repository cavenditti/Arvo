-- Band 0100–0109 (be-plant-insights) — plant-level alerts (FR-P-061).
--
-- Plant alerts are ORDINARY `alerts` rows: the whole Tier-0 lifecycle (ack / dismiss / snooze /
-- assign, the `alerts_dedupe_key` unique index, the elapsed-snooze auto-reopen) is reused
-- untouched, and `modules/alerts.rs` is not edited this phase. All this migration adds is the
-- link to the plant, so a plant alert can be filtered, joined to its label, and cascaded away
-- with its plant.
--
-- Additive only: no existing kind, index or constraint is dropped or narrowed. Runs after
-- 0070_plants.sql, which creates the referenced `plants` table.

ALTER TABLE alerts
    ADD COLUMN plant_id uuid REFERENCES plants(id) ON DELETE CASCADE;

-- Partial: only a handful of alerts are plant-scoped, and every read that uses this column
-- (`GET /plant-alerts`, `GET /plants/{id}/alerts`, the MVT `alert` flag) filters on NOT NULL.
CREATE INDEX alerts_plant_idx ON alerts (plant_id) WHERE plant_id IS NOT NULL;

-- `alerts.kind` itself stays unconstrained (0002 deliberately left it open for the Tier-A
-- intervention kinds). This only pins the four plant kinds: a row that names a plant must be
-- one of them, so a mis-typed kind can never silently produce a plant alert the app cannot
-- render. Pre-existing rows all have plant_id NULL and pass unchanged.
ALTER TABLE alerts
    ADD CONSTRAINT alerts_plant_kind_check
    CHECK (plant_id IS NULL OR kind IN (
        'plant_vigor_outlier', 'plant_missing', 'plant_dead', 'plant_drop'
    ));
