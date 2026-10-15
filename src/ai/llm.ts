import Anthropic from "@anthropic-ai/sdk";

/** Models from the plan: Sonnet answers patients, Haiku routes each message. */
export const MODELS = {
  attendant: "claude-sonnet-5-5",
  router: "claude-haiku-5-5",
} as const;

/**
 * The only door to the Claude API. Production uses the official SDK; tests and the
 * deterministic eval use ScriptedLlm, so CI never needs an API key.
 */
export interface LlmClient {
  create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
}

export class AnthropicLlm implements LlmClient {
  private readonly client: Anthropic;

  constructor(apiKey?: string) {
    // Short timeout: a patient is waiting on WhatsApp. The SDK retries 429/5xx twice.
    this.client = new Anthropic({ ...(apiKey ? { apiKey } : {}), timeout: 60_000 });
  }

  create(params: Anthropic.MessageCreateParamsNonStreaming) {
    return this.client.messages.create(params);
  }
}

export function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}
