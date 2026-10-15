import { randomUUID } from "node:crypto";
import { renderTemplate, TEMPLATES, type TemplateName } from "./templates.js";

export type ReplyButton = { id: string; title: string };
/** Row of an interactive list: title up to 24 chars, description up to 72 (Meta limits). */
export type ListRow = { id: string; title: string; description?: string };

export type OutboundMessage =
  | { kind: "text"; to: string; body: string }
  | { kind: "buttons"; to: string; body: string; buttons: ReplyButton[] }
  | { kind: "list"; to: string; body: string; button: string; rows: ListRow[] }
  | {
      kind: "document";
      to: string;
      filename: string;
      mimeType: "application/pdf";
      data: Buffer;
      caption?: string;
    }
  | {
      kind: "template";
      to: string;
      template: TemplateName;
      params: string[];
      /** Payload of each quick-reply button, in the template's button order. */
      buttonPayloads?: string[];
    };

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
    case "list":
      return `${message.body}\n${message.rows.map((r) => `- ${r.title}`).join("\n")}`;
    case "document":
      return `[documento: ${message.filename}]${message.caption ? ` ${message.caption}` : ""}`;
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

  private get baseUrl() {
    return `https://graph.facebook.com/${this.opts.graphApiVersion}/${this.opts.phoneNumberId}`;
  }

  /** Uploads a file to Meta and returns its media id (valid for 30 days). */
  private async uploadMedia(data: Buffer, mimeType: string, filename: string) {
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", mimeType);
    form.append("file", new Blob([new Uint8Array(data)], { type: mimeType }), filename);
    const res = await this.fetchImpl(`${this.baseUrl}/media`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.opts.accessToken}` },
      body: form,
    });
    if (!res.ok) throw new Error(`WhatsApp media upload failed: HTTP ${res.status}`);
    const { id } = (await res.json()) as { id?: string };
    if (!id) throw new Error("WhatsApp media upload returned no id");
    return id;
  }

  async send(message: OutboundMessage) {
    const mediaId =
      message.kind === "document"
        ? await this.uploadMedia(message.data, message.mimeType, message.filename)
        : undefined;
    const url = `${this.baseUrl}/messages`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.opts.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(toCloudApiBody(message, mediaId)),
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

export function toCloudApiBody(
  message: OutboundMessage,
  mediaId?: string,
): Record<string, unknown> {
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
    case "list":
      return {
        ...base,
        type: "interactive",
        interactive: {
          type: "list",
          body: { text: message.body },
          action: {
            button: message.button,
            sections: [
              {
                title: "Opções",
                rows: message.rows.map((r) => ({
                  id: r.id,
                  title: r.title.slice(0, 24),
                  ...(r.description ? { description: r.description.slice(0, 72) } : {}),
                })),
              },
            ],
          },
        },
      };
    case "document":
      if (!mediaId) throw new Error("document messages need an uploaded media id");
      return {
        ...base,
        type: "document",
        document: {
          id: mediaId,
          filename: message.filename,
          ...(message.caption ? { caption: message.caption } : {}),
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
            ...(message.buttonPayloads ?? []).map((payload, index) => ({
              type: "button",
              sub_type: "quick_reply",
              index: String(index),
              parameters: [{ type: "payload", payload }],
            })),
          ],
        },
      };
    }
  }
}
