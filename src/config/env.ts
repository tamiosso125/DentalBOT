import { z } from "zod";

const base64Key32 = z
  .string()
  .refine((v) => Buffer.from(v, "base64").length === 32, "must be 32 bytes encoded in base64");

export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

    DATABASE_URL: z.string().url(),
    /// "memory" runs jobs in-process (dev/tests); "redis" uses BullMQ.
    QUEUE_MODE: z.enum(["memory", "redis"]).default("memory"),
    REDIS_URL: z.string().url().default("redis://localhost:6379"),

    /// Keys for sensitive columns. Generate with: openssl rand -base64 32
    PII_ENCRYPTION_KEY: base64Key32,
    PII_HASH_SECRET: z.string().min(32),

    /// "sandbox" keeps outbound messages in memory (no Meta account needed).
    WHATSAPP_MODE: z.enum(["sandbox", "cloud"]).default("sandbox"),
    WHATSAPP_VERIFY_TOKEN: z.string().min(16),
    WHATSAPP_APP_SECRET: z.string().min(16),
    WHATSAPP_ACCESS_TOKEN: z.string().optional(),
    WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
    WHATSAPP_GRAPH_API_VERSION: z.string().default("v23.0"),

    /// Minutes the bot stays silent after a human takes over the conversation.
    HANDOFF_PAUSE_MINUTES: z.coerce.number().int().positive().default(240),

    /// "mock" needs no account; "sandbox" uses api-sandbox.asaas.com.
    ASAAS_ENV: z.enum(["mock", "sandbox", "production"]).default("mock"),
    ASAAS_API_KEY: z.string().optional(),
    ASAAS_WEBHOOK_TOKEN: z.string().min(16),

    /// "off" = deterministic menu only; "anthropic" = router + attendant via the Claude API.
    AI_MODE: z.enum(["off", "anthropic"]).default("off"),
    ANTHROPIC_API_KEY: z.string().optional(),
    AI_ATTENDANT_EFFORT: z.enum(["low", "medium", "high"]).default("medium"),

    /// Bearer token for the clinic staff API (/admin/*). Unset = API off. openssl rand -hex 32
    ADMIN_API_TOKEN: z.string().min(32).optional(),

    PRIVACY_POLICY_URL: z.string().url().default("https://example.com/privacidade"),
    /// Clinic used when the WhatsApp phone_number_id is not yet linked to a clinic (sandbox).
    DEFAULT_CLINIC_ID: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.WHATSAPP_MODE === "cloud") {
      for (const key of ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID"] as const) {
        if (!env[key])
          ctx.addIssue({ code: "custom", path: [key], message: "required in cloud mode" });
      }
    }
    if (env.AI_MODE === "anthropic" && !env.ANTHROPIC_API_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["ANTHROPIC_API_KEY"],
        message: "required when AI_MODE=anthropic",
      });
    }
    if (env.ASAAS_ENV !== "mock" && !env.ASAAS_API_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["ASAAS_API_KEY"],
        message: "required unless ASAAS_ENV=mock",
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return parsed.data;
}
