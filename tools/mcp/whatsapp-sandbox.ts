/**
 * MCP server "whatsapp-sandbox": lets Claude Code talk to a locally running DentalBOT as if
 * it were a patient (or the front desk on the WhatsApp Business app), with no Meta account.
 *
 * Requires the API running with WHATSAPP_MODE=sandbox (pnpm dev). Reads from the environment:
 *   DENTALBOT_URL (default http://localhost:3000), WHATSAPP_APP_SECRET (same value as the API),
 *   SANDBOX_PHONE_NUMBER_ID (default "sandbox"), SANDBOX_PATIENT (default 5511900000001).
 */
import { setTimeout as sleep } from "node:timers/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  fakeAppEcho,
  fakeButtonReply,
  fakeTextMessage,
  signBody,
  type WebhookPayload,
} from "../../src/whatsapp/index.js";

const baseUrl = process.env.DENTALBOT_URL ?? "http://localhost:3000";
const appSecret = process.env.WHATSAPP_APP_SECRET ?? "dev-app-secret-troque";
const phoneNumberId = process.env.SANDBOX_PHONE_NUMBER_ID ?? "sandbox";
const defaultPatient = process.env.SANDBOX_PATIENT ?? "5511900000001";

type OutboxMessage = { kind: string; to: string; body?: string; waMessageId: string };

async function outbox(): Promise<OutboxMessage[]> {
  const res = await fetch(`${baseUrl}/dev/sandbox/outbox`);
  if (!res.ok)
    throw new Error(`outbox HTTP ${res.status}: is the API running with WHATSAPP_MODE=sandbox?`);
  return ((await res.json()) as { messages: OutboxMessage[] }).messages;
}

/** Posts a signed webhook and returns the bot replies produced by it. */
async function deliver(payload: WebhookPayload) {
  const before = (await outbox()).length;
  const body = JSON.stringify(payload);
  const res = await fetch(`${baseUrl}/webhooks/whatsapp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": signBody(body, appSecret),
    },
    body,
  });
  if (!res.ok) throw new Error(`webhook HTTP ${res.status}`);
  // Processing is async (queue): poll briefly for replies.
  let replies: OutboxMessage[] = [];
  for (let i = 0; i < 10; i++) {
    await sleep(200);
    replies = (await outbox()).slice(before);
    if (replies.length > 0) break;
  }
  return replies;
}

const asText = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

const server = new McpServer({ name: "whatsapp-sandbox", version: "0.1.0" });

server.registerTool(
  "send_patient_message",
  {
    description: "Simula uma mensagem de texto do paciente e devolve as respostas do bot.",
    inputSchema: { text: z.string(), from: z.string().optional() },
  },
  async ({ text, from }) =>
    asText(await deliver(fakeTextMessage({ phoneNumberId, from: from ?? defaultPatient, text }))),
);

server.registerTool(
  "press_button",
  {
    description: "Simula o paciente tocando num botão de resposta rápida (ex.: menu:agendar).",
    inputSchema: { id: z.string(), title: z.string(), from: z.string().optional() },
  },
  async ({ id, title, from }) =>
    asText(
      await deliver(
        fakeButtonReply({ phoneNumberId, from: from ?? defaultPatient, replyId: id, title }),
      ),
    ),
);

server.registerTool(
  "reception_reply",
  {
    description:
      "Simula a recepção respondendo pelo app WhatsApp Business (coexistência); o bot deve pausar.",
    inputSchema: { text: z.string(), to: z.string().optional() },
  },
  async ({ text, to }) =>
    asText(await deliver(fakeAppEcho({ phoneNumberId, to: to ?? defaultPatient, text }))),
);

server.registerTool(
  "get_outbox",
  { description: "Lista todas as mensagens que o bot enviou no sandbox.", inputSchema: {} },
  async () => asText(await outbox()),
);

server.registerTool(
  "clear_outbox",
  { description: "Limpa a caixa de saída do sandbox.", inputSchema: {} },
  async () => {
    await fetch(`${baseUrl}/dev/sandbox/outbox`, { method: "DELETE" });
    return asText({ cleared: true });
  },
);

await server.connect(new StdioServerTransport());
