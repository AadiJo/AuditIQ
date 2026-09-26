import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { and, count, eq, gt, isNull } from "drizzle-orm";
import { audit } from "./audit.ts";
import { db } from "./db/client.ts";
import * as schema from "./db/schema.ts";
import { env } from "./env.ts";

// Email and password sign-in. Nobody can sign up on their own: the first account becomes
// the owner (an admin), and everyone after needs an open invite for their email address.

function openInvite(email: string) {
  return db
    .select()
    .from(schema.invites)
    .where(
      and(
        eq(schema.invites.email, email.toLowerCase()),
        isNull(schema.invites.acceptedAt),
        gt(schema.invites.expiresAt, new Date().toISOString()),
      ),
    )
    .get();
}

export function hasUsers(): boolean {
  return (db.select({ n: count() }).from(schema.user).get()?.n ?? 0) > 0;
}

export const auth = betterAuth({
  appName: "AuditIQ",
  baseURL: env.BASE_URL,
  secret: env.AUDITIQ_SECRET,
  // Production trusts only BASE_URL. Development trusts whatever origin the Vite dev server is reached on.
  trustedOrigins: env.isProduction
    ? [env.BASE_URL]
    : (request) => [env.BASE_URL, request?.headers.get("origin") ?? env.BASE_URL],
  database: drizzleAdapter(db, {
    provider: "sqlite",
    schema: { user: schema.user, session: schema.session, account: schema.account, verification: schema.verification },
  }),
  emailAndPassword: { enabled: true, minPasswordLength: 10 },
  // Sign-in is rate limited everywhere except the end-to-end suite, which signs in constantly.
  rateLimit: { enabled: env.NODE_ENV !== "test" },
  user: {
    additionalFields: {
      role: { type: "string", input: false, defaultValue: "reviewer" },
    },
  },
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          if (!hasUsers()) return { data: { ...user, role: "admin" } };
          const invite = openInvite(user.email);
          if (!invite) {
            throw new APIError("FORBIDDEN", {
              message: "You need an invite to join this AuditIQ workspace. Ask an admin for one.",
            });
          }
          return { data: { ...user, role: invite.role } };
        },
        after: async (user) => {
          const invite = openInvite(user.email);
          if (invite) {
            db.update(schema.invites)
              .set({ acceptedAt: new Date().toISOString() })
              .where(eq(schema.invites.id, invite.id))
              .run();
          }
          audit(
            "user.created",
            { type: "user", id: user.id },
            { email: user.email, inviteId: invite?.id ?? null },
            user.id,
          );
        },
      },
    },
  },
});

export type SessionUser = typeof auth.$Infer.Session.user;
