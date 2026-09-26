import { randomBytes } from "node:crypto";
import { zValidator } from "@hono/zod-validator";
import { and, count, desc, eq, gt, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { audit } from "../audit.ts";
import { db } from "../db/client.ts";
import { invites, session, user } from "../db/schema.ts";
import { env } from "../env.ts";
import { type AppEnv, badRequest, requireAdmin, requireUser } from "./context.ts";

const INVITE_DAYS = 14;
const Role = z.enum(["admin", "reviewer"]);

function adminCount(): number {
  return db.select({ n: count() }).from(user).where(eq(user.role, "admin")).get()?.n ?? 0;
}

export const memberRoutes = new Hono<AppEnv>()
  .use(requireUser, requireAdmin)
  .get("/", (c) => {
    const members = db
      .select({ id: user.id, name: user.name, email: user.email, role: user.role, createdAt: user.createdAt })
      .from(user)
      .orderBy(user.createdAt)
      .all();
    const open = db
      .select()
      .from(invites)
      .where(and(isNull(invites.acceptedAt), gt(invites.expiresAt, new Date().toISOString())))
      .orderBy(desc(invites.createdAt))
      .all();
    return c.json({ members, invites: open.map((i) => ({ ...i, link: `${env.BASE_URL}/join/${i.id}` })) });
  })

  // Invites are links an admin copies and sends. AuditIQ doesn't need a mail server.
  .post("/invites", zValidator("json", z.object({ email: z.string().email(), role: Role })), (c) => {
    const { email, role } = c.req.valid("json");
    const normalized = email.toLowerCase();
    if (db.select().from(user).where(eq(user.email, normalized)).get())
      badRequest("That person already has an account.", 409);
    const invite = db
      .insert(invites)
      .values({
        id: randomBytes(16).toString("base64url"),
        email: normalized,
        role,
        createdBy: c.var.user.id,
        expiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000).toISOString(),
      })
      .returning()
      .get();
    audit("member.invited", { type: "invite", id: invite.id }, { email: normalized, role }, c.var.user.id);
    return c.json({ ...invite, link: `${env.BASE_URL}/join/${invite.id}` });
  })
  .delete("/invites/:id", (c) => {
    db.delete(invites)
      .where(eq(invites.id, c.req.param("id")))
      .run();
    audit("member.invite_revoked", { type: "invite", id: c.req.param("id") }, {}, c.var.user.id);
    return c.json({ ok: true });
  })

  .patch("/:id", zValidator("json", z.object({ role: Role })), (c) => {
    const target =
      db
        .select()
        .from(user)
        .where(eq(user.id, c.req.param("id")))
        .get() ?? badRequest("That member doesn't exist.", 404);
    const { role } = c.req.valid("json");
    if (target.role === "admin" && role !== "admin" && adminCount() <= 1) badRequest("Keep at least one admin.", 409);
    db.update(user).set({ role, updatedAt: new Date() }).where(eq(user.id, target.id)).run();
    audit("member.role_changed", { type: "user", id: target.id }, { from: target.role, to: role }, c.var.user.id);
    return c.json({ ok: true });
  })
  .delete("/:id", (c) => {
    const target =
      db
        .select()
        .from(user)
        .where(eq(user.id, c.req.param("id")))
        .get() ?? badRequest("That member doesn't exist.", 404);
    if (target.id === c.var.user.id) badRequest("You can't remove yourself.", 409);
    if (target.role === "admin" && adminCount() <= 1) badRequest("Keep at least one admin.", 409);
    db.delete(session).where(eq(session.userId, target.id)).run();
    db.delete(user).where(eq(user.id, target.id)).run();
    audit("member.removed", { type: "user", id: target.id }, { email: target.email }, c.var.user.id);
    return c.json({ ok: true });
  });
