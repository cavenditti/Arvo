import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { toNodeHandler } from "better-auth/node";

import { auth, pool } from "./auth.js";
import { env } from "./env.js";

const betterAuthHandler = toNodeHandler(auth);

function requestHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
}

function setCors(request: IncomingMessage, response: ServerResponse): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  const trusted = env.trustedOrigins.some((entry) => {
    if (entry.endsWith("*")) return origin.startsWith(entry.slice(0, -1));
    return origin === entry;
  });
  if (!trusted) return false;
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Access-Control-Allow-Credentials", "true");
  response.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Cookie, X-Requested-With",
  );
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Vary", "Origin");
  return true;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

async function arvoSession(request: IncomingMessage, response: ServerResponse) {
  const session = await auth.api.getSession({ headers: requestHeaders(request) });
  if (!session) {
    json(response, 401, { error: "unauthorized" });
    return;
  }

  const result = await pool.query<{
    id: string;
    name: string;
    role: "viewer" | "operator" | "agronomist" | "admin" | "owner" | "member";
  }>(
    `SELECT o.id, o.name, m.role
       FROM member m
       JOIN organization o ON o.id = m."organizationId"
      WHERE m."userId" = $1
      ORDER BY m."createdAt"`,
    [session.user.id],
  );
  const orgs = result.rows.map((row) => ({
    ...row,
    role: row.role === "member" ? "viewer" : row.role,
  }));
  const active =
    orgs.find((org) => org.id === session.session.activeOrganizationId) ?? orgs[0];
  if (!active) {
    json(response, 409, { error: "organization_required" });
    return;
  }

  json(response, 200, {
    user: {
      id: session.user.id,
      email: session.user.email,
      full_name: session.user.name,
      locale: "locale" in session.user ? session.user.locale : "it",
    },
    org: { id: active.id, name: active.name },
    orgs,
    role: active.role,
  });
}

const server = createServer(async (request, response) => {
  try {
    if (!setCors(request, response)) {
      json(response, 403, { error: "origin_not_allowed" });
      return;
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    const url = new URL(request.url ?? "/", env.baseUrl);
    if (url.pathname === "/healthz") {
      await pool.query("SELECT 1");
      json(response, 200, { status: "ok" });
      return;
    }
    if (url.pathname === "/api/arvo/session" && request.method === "GET") {
      await arvoSession(request, response);
      return;
    }
    await betterAuthHandler(request, response);
  } catch (error) {
    console.error("auth request failed", error);
    if (!response.headersSent) json(response, 500, { error: "internal_error" });
    else response.end();
  }
});

server.listen(env.port, "0.0.0.0", () => {
  console.info(`arvo-auth listening on http://0.0.0.0:${env.port}`);
});

async function shutdown(signal: string) {
  console.info(`received ${signal}; shutting down`);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
