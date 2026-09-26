import { zValidator } from "@hono/zod-validator";
import type { ValidationTargets } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";
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

/**
 * Request validation that answers bad input with a readable 400. Throwing from the hook
 * also keeps validation errors out of each route's response type, so the web client
 * only sees the success shape.
 */
export function validate<T extends z.ZodType, Target extends keyof ValidationTargets>(target: Target, schema: T) {
  return zValidator(target, schema, (result) => {
    if (!result.success) {
      const issue = result.error.issues[0];
      throw new HTTPException(400, {
        message: issue ? `${issue.path.join(".") || target}: ${issue.message}` : "Invalid request.",
      });
    }
  });
}
