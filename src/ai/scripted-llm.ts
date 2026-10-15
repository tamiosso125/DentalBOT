import type Anthropic from "@anthropic-ai/sdk";
import type { LlmClient } from "./llm.js";

export type ScriptedReply =
  | { text: string }
  | { tool: string; input: Record<string, unknown> }
  | { refusal: true };

/**
 * Deterministic stand-in for Claude: returns queued replies in order and records every
 * request. Router and attendant replies share one queue, in call order.
 */
export class ScriptedLlm implements LlmClient {
  readonly requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  private readonly queue: ScriptedReply[] = [];
  private seq = 0;

  push(...replies: ScriptedReply[]) {
    this.queue.push(...replies);
    return this;
  }

  /** Router reply: the structured JSON the router asks for. */
  route(route: string) {
    return this.push({ text: JSON.stringify({ route }) });
  }

  clear() {
    this.queue.length = 0;
  }

  get pending() {
    return this.queue.length;
  }

  async create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
    this.requests.push(params);
    const next = this.queue.shift();
    if (!next)
      throw new Error(`ScriptedLlm: no scripted reply left (call ${this.requests.length})`);
    const id = `msg_scripted_${++this.seq}`;
    const content: Anthropic.ContentBlock[] =
      "text" in next
        ? [{ type: "text", text: next.text, citations: null }]
        : "tool" in next
          ? [
              {
                type: "tool_use",
                id: `toolu_${this.seq}`,
                name: next.tool,
                input: next.input,
                caller: { type: "direct" },
              },
            ]
          : [];
    const stop_reason: Anthropic.StopReason =
      "tool" in next ? "tool_use" : "refusal" in next ? "refusal" : "end_turn";
    return {
      id,
      type: "message",
      role: "assistant",
      model: params.model,
      content,
      stop_reason,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    } as unknown as Anthropic.Message;
  }
}
