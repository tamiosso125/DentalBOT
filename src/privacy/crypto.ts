import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const VERSION = "v1";

/**
 * Field-level encryption for sensitive columns (phone, CPF, insurance card, message bodies).
 * Format: v1.<iv>.<tag>.<ciphertext>, all base64url.
 */
export class FieldCipher {
  private readonly key: Buffer;
  private readonly hashSecret: string;

  constructor(base64Key: string, hashSecret: string) {
    this.key = Buffer.from(base64Key, "base64");
    if (this.key.length !== 32) throw new Error("PII encryption key must be 32 bytes");
    if (hashSecret.length < 32) throw new Error("PII hash secret must have at least 32 chars");
    this.hashSecret = hashSecret;
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGO, this.key, iv);
    const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv, tag, data]
      .map((p) => (typeof p === "string" ? p : p.toString("base64url")))
      .join(".");
  }

  decrypt(payload: string): string {
    const [version, iv, tag, data] = payload.split(".");
    if (version !== VERSION || !iv || !tag || data === undefined) {
      throw new Error("Unsupported ciphertext format");
    }
    const decipher = createDecipheriv(ALGO, this.key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(data, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }

  /** Deterministic keyed hash, used to look records up without storing the plain value. */
  hash(normalized: string): string {
    return createHmac("sha256", this.hashSecret).update(normalized).digest("hex");
  }
}
