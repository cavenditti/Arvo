import { expo } from "@better-auth/expo";
import { hash, verify } from "@node-rs/argon2";
import { betterAuth } from "better-auth";
import { jwt, organization } from "better-auth/plugins";
import pg from "pg";

import { sendPasswordResetEmail } from "./email.js";
import { env } from "./env.js";

export const pool = new pg.Pool({
  connectionString: env.databaseUrl,
  max: env.databaseMaxConnections,
});

type MembershipRow = {
  organizationId: string;
  role: string;
};

async function firstMembership(userId: string): Promise<MembershipRow | null> {
  const result = await pool.query<MembershipRow>(
    `SELECT "organizationId", role
       FROM member
      WHERE "userId" = $1
      ORDER BY "createdAt"
      LIMIT 1`,
    [userId],
  );
  return result.rows[0] ?? null;
}

async function membership(
  userId: string,
  organizationId: string | null | undefined,
): Promise<MembershipRow | null> {
  if (!organizationId) return firstMembership(userId);
  const result = await pool.query<MembershipRow>(
    `SELECT "organizationId", role
       FROM member
      WHERE "userId" = $1 AND "organizationId" = $2
      LIMIT 1`,
    [userId, organizationId],
  );
  return result.rows[0] ?? null;
}

export const auth = betterAuth({
  appName: "Arvo",
  baseURL: env.baseUrl,
  secret: env.secret,
  database: pool,
  trustedOrigins: env.trustedOrigins,
  advanced: {
    database: { generateId: "uuid" },
    useSecureCookies: !env.development,
  },
  user: {
    additionalFields: {
      locale: {
        type: "string",
        required: false,
        defaultValue: "it",
      },
    },
  },
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    maxPasswordLength: 512,
    revokeSessionsOnPasswordReset: true,
    password: {
      hash: (password) => hash(password),
      verify: ({ hash: encoded, password }) => verify(encoded, password),
    },
    sendResetPassword: async ({ user, url }) => {
      if (env.development && !env.temApiKey) {
        console.info("Better Auth password reset", { email: user.email, url });
        return;
      }
      // Do not await the provider: response timing must not become a user-enumeration signal.
      void sendPasswordResetEmail({
        email: user.email,
        name: user.name,
        url,
      }).catch((error) => console.error("password reset email failed", error));
    },
  },
  databaseHooks: {
    session: {
      create: {
        before: async (session) => {
          if (session.activeOrganizationId) return;
          const active = await firstMembership(session.userId);
          return active
            ? {
                data: {
                  ...session,
                  activeOrganizationId: active.organizationId,
                },
              }
            : undefined;
        },
      },
    },
  },
  plugins: [
    organization({
      creatorRole: "owner",
    }),
    jwt({
      jwks: {
        rotationInterval: 60 * 60 * 24 * 30,
        gracePeriod: 60 * 60 * 24 * 30,
      },
      jwt: {
        issuer: env.baseUrl,
        audience: env.apiAudience,
        expirationTime: "15m",
        definePayload: async ({ user, session }) => {
          const active = await membership(user.id, session.activeOrganizationId);
          if (!active) {
            throw new Error("No active Arvo organization for this session");
          }
          return {
            email: user.email,
            locale: "locale" in user ? user.locale : "it",
            org: active.organizationId,
            role: active.role === "member" ? "viewer" : active.role,
          };
        },
      },
    }),
    expo(),
  ],
});
