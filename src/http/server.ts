import { timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import type { Logger } from "../lib/logger.js";
import { asaasWebhookSchema, type AsaasWebhookEvent } from "../payments/asaas.js";
import type { JobQueue } from "../queue/queue.js";
import {
  isValidSignature,
  normalizeWebhook,
  webhookPayloadSchema,
  type SandboxChannel,
  type WhatsAppEvent,
} from "../whatsapp/index.js";

export type ServerDeps = {
  logger: Logger;
  whatsappQueue: JobQueue<WhatsAppEvent>;
  asaasQueue: JobQueue<AsaasWebhookEvent>;
  config: {
    whatsappVerifyToken: string;
    whatsappAppSecret: string;
    asaasWebhookToken: string;
  };
  /** Only set in sandbox mode outside production: exposes the fake outbox for dev tools. */
  sandbox?: SandboxChannel;
};

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

function safeEqual(a: string | undefined, b: string): boolean {
  if (a === undefined) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function buildServer(deps: ServerDeps) {
  const app = Fastify({
    loggerInstance: deps.logger,
    bodyLimit: 1_048_576,
    // Request logs carry no bodies or query strings (hub.verify_token, phone numbers).
    disableRequestLogging: true,
  });

  // Keep the raw bytes: Meta signs the exact body it sent.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    req.rawBody = body as Buffer;
    try {
      done(null, (body as Buffer).length ? JSON.parse((body as Buffer).toString("utf8")) : {});
    } catch {
      const err = new Error("Invalid JSON") as Error & { statusCode: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  app.get("/health", async () => ({ status: "ok" }));

  // Meta webhook verification handshake.
  app.get("/webhooks/whatsapp", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    if (
      q["hub.mode"] === "subscribe" &&
      safeEqual(q["hub.verify_token"], deps.config.whatsappVerifyToken)
    ) {
      return reply.type("text/plain").send(q["hub.challenge"] ?? "");
    }
    return reply.code(403).send();
  });

  app.post("/webhooks/whatsapp", async (req, reply) => {
    const signature = req.headers["x-hub-signature-256"];
    if (
      !req.rawBody ||
      !isValidSignature(
        req.rawBody,
        typeof signature === "string" ? signature : undefined,
        deps.config.whatsappAppSecret,
      )
    ) {
      deps.logger.warn("whatsapp webhook with invalid signature");
      return reply.code(401).send();
    }

    const parsed = webhookPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      // Answer 200 anyway: a payload we cannot read will not get better on retry.
      deps.logger.warn({ issues: parsed.error.issues.length }, "unrecognized whatsapp payload");
      return reply.code(200).send();
    }

    for (const event of normalizeWebhook(parsed.data)) {
      const suffix = event.kind === "status" ? `_${event.status}` : "";
      await deps.whatsappQueue.enqueue(event, {
        jobId: `wa_${event.kind}_${event.waMessageId}${suffix}`,
      });
    }
    return reply.code(200).send();
  });

  app.post("/webhooks/asaas", async (req, reply) => {
    const token = req.headers["asaas-access-token"];
    if (!safeEqual(typeof token === "string" ? token : undefined, deps.config.asaasWebhookToken)) {
      deps.logger.warn("asaas webhook with invalid token");
      return reply.code(401).send();
    }
    const parsed = asaasWebhookSchema.safeParse(req.body);
    if (!parsed.success) {
      deps.logger.warn({ issues: parsed.error.issues.length }, "unrecognized asaas payload");
      return reply.code(200).send();
    }
    await deps.asaasQueue.enqueue(parsed.data, { jobId: `asaas_${parsed.data.id}` });
    return reply.code(200).send({ received: true });
  });

  if (deps.sandbox) {
    const sandbox = deps.sandbox;
    app.get("/dev/sandbox/outbox", async () => ({ messages: sandbox.outbox }));
    app.delete("/dev/sandbox/outbox", async () => {
      sandbox.clear();
      return { cleared: true };
    });
  }

  return app;
}
