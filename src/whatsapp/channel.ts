import { randomUUID } from "node:crypto";
import { renderTemplate, TEMPLATES, type TemplateName } from "./templates.js";

export type ReplyButton = { id: string; title: string };

export type OutboundMessage =
  | { kind: "text"; to: string; body: string }
  | { kind: "buttons"; to: string; body: string; buttons: ReplyButton[] }
  | { kind: "template"; to: string; template: TemplateName; params: string[] };

/**
 * Channel abstraction. The rest of the code never talks to Meta directly, so the
 * provider (Cloud API, a BSP, the sandbox) can be swapped.
 */
export interface WhatsAppChannel {
  send(message: OutboundMessage): Promise<{ waMessageId: string }>;
}

/** Plain text equivalent of an outbound message, for storage and evals. */
export function previewText(message: OutboundMessage): string {
  switch (message.kind) {
    case "text":
      return message.body;
    case "buttons":
      return `${message.body}\n${message.buttons.map((b) => `[${b.title}]`).join(" ")}`;
    case "template":
      return renderTemplate(message.template, message.params);
  }
}

/** Keeps messages in memory. Used in dev (WHATSAPP_MODE=sandbox), tests and evals. */
export class SandboxChannel implements WhatsAppChannel {
  readonly outbox: Array<OutboundMessage & { waMessageId: string; sentAt: Date }> = [];

  async send(message: OutboundMessage) {
    if (message.kind === "template") renderTemplate(message.template, message.params);
    const waMessageId = `wamid.sandbox.${randomUUID()}`;
    this.outbox.push({ ...message, waMessageId, sentAt: new Date() });
    return { waMessageId };
  }

  clear() {
    this.outbox.length = 0;
  }
}

type CloudApiOptions = {
  accessToken: string;
  phoneNumberId: string;
  graphApiVersion: string;
  fetchImpl?: typeof fetch;
};

/** WhatsApp Cloud API (graph.facebook.com). Requires a verified Meta Business account. */
export class CloudApiChannel implements WhatsAppChannel {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: CloudApiOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async send(message: OutboundMessage) {
    const url = `https://graph.facebook.com/${this.opts.graphApiVersion}/${this.opts.phoneNumberId}/messages`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.opts.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(toCloudApiBody(message)),
    });
    if (!res.ok) {
      // Body may echo the recipient; keep only the status and Meta's error code.
      const err = (await res.json().catch(() => ({}))) as { error?: { code?: number } };
      throw new Error(`WhatsApp send failed: HTTP ${res.status} code ${err.error?.code ?? "?"}`);
    }
    const data = (await res.json()) as { messages?: Array<{ id: string }> };
    const id = data.messages?.[0]?.id;
    if (!id) throw new Error("WhatsApp send returned no message id");
    return { waMessageId: id };
  }
}

export function toCloudApiBody(message: OutboundMessage): Record<string, unknown> {
  const base = { messaging_product: "whatsapp", recipient_type: "individual", to: message.to };
  switch (message.kind) {
    case "text":
      return { ...base, type: "text", text: { body: message.body, preview_url: false } };
    case "buttons":
      return {
        ...base,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: message.body },
          action: {
            buttons: message.buttons.map((b) => ({
              type: "reply",
              reply: { id: b.id, title: b.title },
            })),
          },
        },
      };
    case "template": {
      const tpl = TEMPLATES[message.template];
      renderTemplate(message.template, message.params);
      return {
        ...base,
        type: "template",
        template: {
          name: tpl.name,
          language: { code: tpl.language },
          components: [
            {
              type: "body",
              parameters: message.params.map((text) => ({ type: "text", text })),
            },
          ],
        },
      };
    }
  }
}
