const development = process.env.NODE_ENV !== "production";

function required(name: string, developmentDefault?: string): string {
  const value = process.env[name]?.trim();
  if (value) return value;
  if (development && developmentDefault !== undefined) return developmentDefault;
  throw new Error(`${name} is required`);
}

function list(name: string, fallback: string[]): string[] {
  const value = process.env[name];
  return value
    ? value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : fallback;
}

export const env = {
  development,
  port: Number(process.env.PORT ?? "3000"),
  databaseUrl: required(
    "DATABASE_URL",
    "postgres://arvo:arvo@localhost:5439/arvo",
  ),
  secret: required(
    "BETTER_AUTH_SECRET",
    "arvo-development-secret-change-me-32-characters",
  ),
  baseUrl: required("BETTER_AUTH_URL", "http://localhost:3000"),
  apiAudience: required("ARVO_API_AUDIENCE", "http://localhost:8787"),
  trustedOrigins: list("BETTER_AUTH_TRUSTED_ORIGINS", [
    "arvo://",
    "arvo://*",
    "http://localhost:8081",
    "http://localhost:19006",
  ]),
  databaseMaxConnections: Number(
    process.env.DATABASE_MAX_CONNECTIONS ?? "5",
  ),
  temApiKey: required("SCW_TEM_API_KEY", ""),
  scalewayProjectId: required(
    "SCW_PROJECT_ID",
    "405e5323-69ec-4189-9e01-444937eb0b16",
  ),
  temRegion: process.env.SCW_TEM_REGION?.trim() || "fr-par",
  temSender: process.env.SCW_TEM_SENDER?.trim() || "no-reply@arvo.farm",
};

if (!Number.isInteger(env.port) || env.port < 1 || env.port > 65535) {
  throw new Error("PORT must be a valid TCP port");
}

if (env.secret.length < 32) {
  throw new Error("BETTER_AUTH_SECRET must be at least 32 characters");
}
