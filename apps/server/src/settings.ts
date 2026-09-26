import type { Effort, RuntimeId } from "@auditiq/shared";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Sealed } from "./crypto.ts";
import { db } from "./db/client.ts";
import { settings } from "./db/schema.ts";

// Typed settings stored as JSON rows. Each key has a schema and a default, so readers
// always get a complete value and old rows gain new fields without a migration.

const SealedSchema = z.object({ v: z.literal(1), iv: z.string(), tag: z.string(), data: z.string(), hint: z.string() });
const Priority = z.object({ id: z.string(), name: z.string() });

const schemas = {
  jira: z.object({
    siteUrl: z.string().default(""),
    email: z.string().default(""),
    apiToken: SealedSchema.nullable().default(null),
    /** Where REST calls go: the site URL, or api.atlassian.com/ex/jira/{cloudId} for scoped tokens. */
    apiBaseUrl: z.string().default(""),
    accountId: z.string().default(""),
    displayName: z.string().default(""),
    /** The service account's Jira time zone. JQL date filters are read in it. */
    timeZone: z.string().default("UTC"),
    projectKey: z.string().default(""),
    projectName: z.string().default(""),
    issueTypeId: z.string().default(""),
    issueTypeName: z.string().default(""),
    priorities: z
      .object({ high: Priority.nullable(), medium: Priority.nullable(), low: Priority.nullable() })
      .default({ high: null, medium: null, low: null }),
  }),
  runtime: z.object({
    default: z.enum(["claude", "codex"]).default("claude"),
    allowOverride: z.boolean().default(true),
    claude: z
      .object({
        model: z.string().default("claude-opus-5"),
        effort: z.enum(["low", "medium", "high"]).default("medium"),
        apiKey: SealedSchema.nullable().default(null),
      })
      .default({ model: "claude-opus-5", effort: "medium", apiKey: null }),
    codex: z
      .object({
        model: z.string().default("gpt-5.5"),
        effort: z.enum(["low", "medium", "high"]).default("low"),
        apiKey: SealedSchema.nullable().default(null),
      })
      .default({ model: "gpt-5.5", effort: "low", apiKey: null }),
  }),
  watcher: z.object({
    /** off: ignore mentions. shadow: record decisions only. assist: post evidence-backed replies. */
    mode: z.enum(["off", "shadow", "assist"]).default("shadow"),
  }),
  poll: z.object({
    watermark: z.string().nullable().default(null),
    lastSuccessAt: z.string().nullable().default(null),
    lastError: z.string().nullable().default(null),
    lastReconcileAt: z.string().nullable().default(null),
  }),
} satisfies Record<string, z.ZodType>;

type Schemas = typeof schemas;
export type SettingKey = keyof Schemas;
export type Setting<K extends SettingKey> = z.output<Schemas[K]>;
export type JiraSettings = Setting<"jira">;
export type RuntimeSettings = Setting<"runtime">;
export type RuntimeConfig = { model: string; effort: Effort; apiKey: Sealed | null };
export type { RuntimeId };

export function getSetting<K extends SettingKey>(key: K): Setting<K> {
  const row = db.select().from(settings).where(eq(settings.key, key)).get();
  return schemas[key].parse(row?.value ?? {}) as Setting<K>;
}

export function setSetting<K extends SettingKey>(key: K, value: Setting<K>): Setting<K> {
  const parsed = schemas[key].parse(value) as Setting<K>;
  db.insert(settings)
    .values({ key, value: parsed })
    .onConflictDoUpdate({ target: settings.key, set: { value: parsed, updatedAt: new Date().toISOString() } })
    .run();
  return parsed;
}

export function updateSetting<K extends SettingKey>(key: K, patch: (current: Setting<K>) => Setting<K>): Setting<K> {
  return setSetting(key, patch(getSetting(key)));
}
