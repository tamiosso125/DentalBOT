import { z } from "zod";

/**
 * Subset of the WhatsApp Cloud API webhook payload we act on.
 * Unknown fields are kept loose so Meta adding fields never breaks ingestion.
 */

const textPart = z.object({ body: z.string() });

const inboundMessage = z.object({
  id: z.string(),
  from: z.string(),
  timestamp: z.string(),
  type: z.string(),
  text: textPart.optional(),
  button: z.object({ payload: z.string().optional(), text: z.string() }).optional(),
  interactive: z
    .object({
      type: z.string(),
      button_reply: z.object({ id: z.string(), title: z.string() }).optional(),
      list_reply: z.object({ id: z.string(), title: z.string() }).optional(),
    })
    .optional(),
});

/** Coexistence: messages the front desk sent from the WhatsApp Business app. */
const messageEcho = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  timestamp: z.string(),
  type: z.string(),
  text: textPart.optional(),
});

const status = z.object({
  id: z.string(),
  status: z.string(),
  timestamp: z.string(),
  recipient_id: z.string(),
});

const changeValue = z.object({
  messaging_product: z.literal("whatsapp").optional(),
  metadata: z.object({ phone_number_id: z.string(), display_phone_number: z.string() }).optional(),
  messages: z.array(inboundMessage).optional(),
  message_echoes: z.array(messageEcho).optional(),
  statuses: z.array(status).optional(),
});

export const webhookPayloadSchema = z.object({
  object: z.string(),
  entry: z.array(
    z.object({
      id: z.string(),
      changes: z.array(z.object({ field: z.string(), value: changeValue })),
    }),
  ),
});

export type WebhookPayload = z.infer<typeof webhookPayloadSchema>;

// ---------- Normalized internal events ----------

export type InboundEvent = {
  kind: "inbound";
  phoneNumberId: string;
  waMessageId: string;
  from: string;
  timestamp: number;
  type: string;
  /** Free text, button text or interactive title. */
  text?: string;
  /** Payload/id of a quick-reply or interactive button, when the patient tapped one. */
  replyId?: string;
};

export type EchoEvent = {
  kind: "echo";
  phoneNumberId: string;
  waMessageId: string;
  to: string;
  timestamp: number;
  type: string;
  text?: string;
};

export type StatusEvent = {
  kind: "status";
  phoneNumberId: string;
  waMessageId: string;
  status: string;
  timestamp: number;
};

export type WhatsAppEvent = InboundEvent | EchoEvent | StatusEvent;

export function normalizeWebhook(payload: WebhookPayload): WhatsAppEvent[] {
  const events: WhatsAppEvent[] = [];
  for (const entry of payload.entry) {
    for (const change of entry.changes) {
      const v = change.value;
      const phoneNumberId = v.metadata?.phone_number_id ?? entry.id;
      for (const m of v.messages ?? []) {
        events.push({
          kind: "inbound",
          phoneNumberId,
          waMessageId: m.id,
          from: m.from,
          timestamp: Number(m.timestamp),
          type: m.type,
          text:
            m.text?.body ??
            m.button?.text ??
            m.interactive?.button_reply?.title ??
            m.interactive?.list_reply?.title,
          replyId:
            m.button?.payload ?? m.interactive?.button_reply?.id ?? m.interactive?.list_reply?.id,
        });
      }
      for (const e of v.message_echoes ?? []) {
        events.push({
          kind: "echo",
          phoneNumberId,
          waMessageId: e.id,
          to: e.to,
          timestamp: Number(e.timestamp),
          type: e.type,
          text: e.text?.body,
        });
      }
      for (const s of v.statuses ?? []) {
        events.push({
          kind: "status",
          phoneNumberId,
          waMessageId: s.id,
          status: s.status,
          timestamp: Number(s.timestamp),
        });
      }
    }
  }
  return events;
}
