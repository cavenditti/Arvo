-- Cadastre-assisted onboarding (FR-0-010b): parcels remember the cadastral parcel they came
-- from and can carry one cover photo (multipart upload, served like scouting photos).
ALTER TABLE parcels ADD COLUMN IF NOT EXISTS cadastral_ref text;
ALTER TABLE parcels ADD COLUMN IF NOT EXISTS photo_path text;

-- The cadastre endpoint marks viewport parcels already onboarded by this org; the lookup is
-- by reference, so index only rows that actually have one.
CREATE INDEX IF NOT EXISTS parcels_org_cadastral_ref_idx
    ON parcels (org_id, cadastral_ref)
    WHERE cadastral_ref IS NOT NULL;
