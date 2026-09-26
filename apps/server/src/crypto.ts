import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { env } from "./env.ts";

// Stored secrets (Jira and model API keys) are sealed with AES-256-GCM under a key derived
// from AUDITIQ_SECRET. Rotating AUDITIQ_SECRET makes existing secrets unreadable, so the UI
// asks the admin to re-enter them.
const key = Buffer.from(hkdfSync("sha256", env.AUDITIQ_SECRET, "auditiq", "settings-v1", 32));

export type Sealed = { v: 1; iv: string; tag: string; data: string; hint: string };

export function seal(plaintext: string): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    v: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
    hint: plaintext.slice(-4),
  };
}

/** Returns null when the secret was sealed under a different AUDITIQ_SECRET. */
export function unseal(sealed: Sealed): string | null {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
