-- Push notifications + password reset (UX revamp).

-- One row per Expo push token; registration upserts by token, so a device that switches
-- user or org (logout/login) is re-bound rather than duplicated.
CREATE TABLE devices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform text NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
    token text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now()
);
-- Push fan-out reads every token of one org.
CREATE INDEX devices_org_idx ON devices (org_id);

-- One-time password-reset tokens, argon2-hashed at rest (a DB leak must not yield usable
-- reset links). Confirm verifies against recent unexpired unused rows, then marks used_at.
CREATE TABLE password_resets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash text NOT NULL,
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX password_resets_user_idx ON password_resets (user_id);
