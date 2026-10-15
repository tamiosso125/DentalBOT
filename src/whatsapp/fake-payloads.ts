import { randomUUID } from "node:crypto";
import type { WebhookPayload } from "./webhook-schema.js";

/**
 * Builders for fake Meta webhook payloads, shaped like the real ones.
 * Used by tests, the conversation eval and the whatsapp-sandbox MCP server.
 */

type Base = { phoneNumberId: string; displayPhone?: string };

let seq = 0;
// Random part: test files run in parallel processes against one database.
const nextId = (prefix: string) =>
  `wamid.${prefix}.${Date.now()}.${++seq}.${randomUUID().slice(0, 8)}`;
const nowTs = () => String(Math.floor(Date.now() / 1000));

function envelope(base: Base, field: string, value: Record<string, unknown>): WebhookPayload {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba_sandbox",
        changes: [
          {
            field,
            value: {
              messaging_product: "whatsapp",
              metadata: {
                phone_number_id: base.phoneNumberId,
                display_phone_number: base.displayPhone ?? "551130000000",
              },
              ...value,
            },
          },
        ],
      },
    ],
  };
}

export function fakeTextMessage(base: Base & { from: string; text: string; id?: string }) {
  return envelope(base, "messages", {
    messages: [
      {
        id: base.id ?? nextId("in"),
        from: base.from,
        timestamp: nowTs(),
        type: "text",
        text: { body: base.text },
      },
    ],
  });
}

export function fakeButtonReply(base: Base & { from: string; replyId: string; title: string }) {
  return envelope(base, "messages", {
    messages: [
      {
        id: nextId("in"),
        from: base.from,
        timestamp: nowTs(),
        type: "interactive",
        interactive: {
          type: "button_reply",
          button_reply: { id: base.replyId, title: base.title },
        },
      },
    ],
  });
}

export function fakeListReply(base: Base & { from: string; replyId: string; title: string }) {
  return envelope(base, "messages", {
    messages: [
      {
        id: nextId("in"),
        from: base.from,
        timestamp: nowTs(),
        type: "interactive",
        interactive: { type: "list_reply", list_reply: { id: base.replyId, title: base.title } },
      },
    ],
  });
}

/** Coexistence echo: the front desk answered from the WhatsApp Business app. */
export function fakeAppEcho(base: Base & { to: string; text: string }) {
  return envelope(base, "smb_message_echoes", {
    message_echoes: [
      {
        id: nextId("echo"),
        from: base.displayPhone ?? "551130000000",
        to: base.to,
        timestamp: nowTs(),
        type: "text",
        text: { body: base.text },
      },
    ],
  });
}
