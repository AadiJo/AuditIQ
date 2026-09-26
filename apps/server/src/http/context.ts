import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { auth, type SessionUser } from "../auth.ts";

export type AppEnv = { Variables: { user: SessionUser } };

/** Rejects requests without a session and exposes the signed-in user as `c.var.user`. */
export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) throw new HTTPException(401, { message: "Sign in to continue." });
  c.set("user", session.user);
  await next();
});

export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  if (c.var.user.role !== "admin") throw new HTTPException(403, { message: "Only admins can do that." });
  await next();
});

/** A 4xx error whose message is safe to show the user. */
export function badRequest(message: string, status: 400 | 404 | 409 = 400): never {
  throw new HTTPException(status, { message });
}
