-- Per-plant scouting (FR-P-060): pin a scouting observation to a single plant.
--
-- Additive and nullable: the offline sync protocol is unchanged, so every existing row and
-- every client that never sends the field stays valid. ON DELETE SET NULL mirrors
-- `parcel_id` — removing a plant must never destroy the field notes taken about it.
ALTER TABLE observations
    ADD COLUMN plant_id uuid REFERENCES plants(id) ON DELETE SET NULL;
CREATE INDEX obs_plant_idx ON observations (plant_id) WHERE plant_id IS NOT NULL;
