-- Sentinel-2 parcel analysis: crop phenology classification + parcel-scale vegetation presence.
-- Individual plants are deliberately not represented here: Sentinel-2's 10 m pixels support
-- vegetation cover and crop-pattern inference, while the Phase-P capture pipeline remains the
-- source of individual plant identities.

-- `crop_source` protects farmer input. A satellite result may fill an unknown crop or refresh a
-- previous satellite result, but can never overwrite a value a person entered or confirmed.
ALTER TABLE parcels
    ADD COLUMN crop_source text
        CHECK (crop_source IN ('manual', 'sentinel-2'));

UPDATE parcels SET crop_source = 'manual' WHERE crop IS NOT NULL;

CREATE TABLE parcel_satellite_analysis (
    parcel_id uuid PRIMARY KEY REFERENCES parcels(id) ON DELETE CASCADE,
    latest_scene_id uuid REFERENCES scenes(id) ON DELETE SET NULL,
    observed_at timestamptz,
    vegetation_detected boolean,
    vegetation_cover_pct double precision
        CHECK (vegetation_cover_pct BETWEEN 0 AND 100),
    clear_pixel_count int CHECK (clear_pixel_count >= 0),
    vegetated_pixel_count int CHECK (vegetated_pixel_count >= 0),
    crop_type text,
    crop_confidence double precision
        CHECK (crop_confidence BETWEEN 0 AND 1),
    crop_scene_count int NOT NULL DEFAULT 0 CHECK (crop_scene_count >= 0),
    crop_month_count int NOT NULL DEFAULT 0 CHECK (crop_month_count BETWEEN 0 AND 12),
    model_version text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX parcel_satellite_analysis_observed_idx
    ON parcel_satellite_analysis (observed_at DESC);
