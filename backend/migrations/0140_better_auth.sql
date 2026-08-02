-- Better Auth 1.6 schema and compatibility bridge.
--
-- Better Auth owns credentials, sessions, password resets and organization sessions. The
-- original plural tables remain Arvo's domain identities because every agronomic table already
-- references their UUIDs. IDs are deliberately identical on both sides and the triggers below
-- keep new Better Auth records reflected in the domain tables atomically.

CREATE TABLE "user" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "name" text NOT NULL,
    "email" text NOT NULL UNIQUE,
    "emailVerified" boolean NOT NULL,
    "image" text,
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    "updatedAt" timestamptz NOT NULL DEFAULT now(),
    "locale" text
);

CREATE TABLE "session" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "expiresAt" timestamptz NOT NULL,
    "token" text NOT NULL UNIQUE,
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    "updatedAt" timestamptz NOT NULL,
    "ipAddress" text,
    "userAgent" text,
    "userId" uuid NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
    "activeOrganizationId" text
);

CREATE TABLE "account" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "accountId" text NOT NULL,
    "providerId" text NOT NULL,
    "userId" uuid NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
    "accessToken" text,
    "refreshToken" text,
    "idToken" text,
    "accessTokenExpiresAt" timestamptz,
    "refreshTokenExpiresAt" timestamptz,
    "scope" text,
    "password" text,
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    "updatedAt" timestamptz NOT NULL
);

CREATE TABLE "verification" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "identifier" text NOT NULL,
    "value" text NOT NULL,
    "expiresAt" timestamptz NOT NULL,
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    "updatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "organization" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "name" text NOT NULL,
    "slug" text NOT NULL UNIQUE,
    "logo" text,
    "createdAt" timestamptz NOT NULL,
    "metadata" text
);

CREATE TABLE "member" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "organizationId" uuid NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
    "userId" uuid NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
    "role" text NOT NULL,
    "createdAt" timestamptz NOT NULL
);

CREATE TABLE "invitation" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "organizationId" uuid NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
    "email" text NOT NULL,
    "role" text,
    "status" text NOT NULL,
    "expiresAt" timestamptz NOT NULL,
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    "inviterId" uuid NOT NULL REFERENCES "user"("id") ON DELETE CASCADE
);

CREATE TABLE "jwks" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "publicKey" text NOT NULL,
    "privateKey" text NOT NULL,
    "createdAt" timestamptz NOT NULL,
    "expiresAt" timestamptz
);

CREATE INDEX better_auth_session_user_idx ON "session"("userId");
CREATE INDEX better_auth_account_user_idx ON "account"("userId");
CREATE UNIQUE INDEX better_auth_account_provider_key
    ON "account"("providerId", "accountId");
CREATE INDEX better_auth_verification_identifier_idx ON "verification"("identifier");
CREATE INDEX better_auth_member_org_idx ON "member"("organizationId");
CREATE INDEX better_auth_member_user_idx ON "member"("userId");
CREATE UNIQUE INDEX better_auth_member_user_org_key ON "member"("userId", "organizationId");
CREATE INDEX better_auth_invitation_org_idx ON "invitation"("organizationId");
CREATE INDEX better_auth_invitation_email_idx ON "invitation"("email");

-- Preserve every existing identity and Argon2id credential. Better Auth is configured with the
-- same Argon2 verifier, so users keep their passwords across the cut-over.
INSERT INTO "user" (
    "id", "name", "email", "emailVerified", "createdAt", "updatedAt", "locale"
)
SELECT id, full_name, email, true, created_at, created_at, locale
FROM users;

INSERT INTO "account" (
    "accountId", "providerId", "userId", "password", "createdAt", "updatedAt"
)
SELECT id::text, 'credential', id, password_hash, created_at, created_at
FROM users;

INSERT INTO "organization" ("id", "name", "slug", "createdAt")
SELECT
    id,
    name,
    trim(both '-' FROM regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g'))
        || '-' || left(replace(id::text, '-', ''), 8),
    created_at
FROM orgs;

INSERT INTO "member" ("organizationId", "userId", "role", "createdAt")
SELECT org_id, user_id, role::text, created_at
FROM memberships;

CREATE FUNCTION better_auth_sync_user_to_domain() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    INSERT INTO users (id, email, password_hash, full_name, locale, created_at)
    VALUES (
        NEW."id",
        NEW."email",
        '',
        NEW."name",
        COALESCE(NEW."locale", 'it'),
        NEW."createdAt"
    )
    ON CONFLICT (id) DO UPDATE SET
        email = EXCLUDED.email,
        full_name = EXCLUDED.full_name,
        locale = EXCLUDED.locale;
    RETURN NEW;
END $$;

CREATE TRIGGER better_auth_user_to_domain
    AFTER INSERT OR UPDATE ON "user"
    FOR EACH ROW EXECUTE FUNCTION better_auth_sync_user_to_domain();

CREATE FUNCTION better_auth_sync_org_to_domain() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    INSERT INTO orgs (id, name, created_at)
    VALUES (NEW."id", NEW."name", NEW."createdAt")
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;
    RETURN NEW;
END $$;

CREATE TRIGGER better_auth_org_to_domain
    AFTER INSERT OR UPDATE ON "organization"
    FOR EACH ROW EXECUTE FUNCTION better_auth_sync_org_to_domain();

CREATE FUNCTION better_auth_sync_member_to_domain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    mapped_role org_role;
BEGIN
    IF TG_OP = 'DELETE' THEN
        DELETE FROM memberships
        WHERE user_id = OLD."userId" AND org_id = OLD."organizationId";
        RETURN OLD;
    END IF;
    mapped_role := CASE WHEN NEW."role" = 'member' THEN 'viewer'::org_role
                        ELSE NEW."role"::org_role END;
    INSERT INTO memberships (user_id, org_id, role, created_at)
    VALUES (NEW."userId", NEW."organizationId", mapped_role, NEW."createdAt")
    ON CONFLICT (user_id, org_id) DO UPDATE SET role = EXCLUDED.role;
    RETURN NEW;
END $$;

CREATE TRIGGER better_auth_member_to_domain
    AFTER INSERT OR UPDATE OR DELETE ON "member"
    FOR EACH ROW EXECUTE FUNCTION better_auth_sync_member_to_domain();
