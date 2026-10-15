import { describe, expect, it } from "vitest";
import { makeDeps, textPayload } from "../../tests/support/fixtures.js";
import { handleWhatsAppEvent } from "../conversation/handler.js";
import { normalizeWebhook, previewText, type WebhookPayload } from "../whatsapp/index.js";
import { MODELS } from "./llm.js";
import { ScriptedLlm } from "./scripted-llm.js";

async function deliver(payload: WebhookPayload, deps: ReturnType<typeof makeDeps>["deps"]) {
  for (const e of normalizeWebhook(payload)) await handleWhatsAppEvent(e, deps);
}

describe("orchestrator", () => {
  it("routes with Haiku, answers with Sonnet, and keeps per-turn context last", async () => {
    const llm = new ScriptedLlm().route("agenda").push({ text: "Qual procedimento?" });
    const { deps } = makeDeps({ llm });
    await deliver(textPayload("quero marcar"), deps);

    const [router, attendant] = llm.requests;
    expect(router!.model).toBe(MODELS.router);
    expect(router!.output_config?.format?.type).toBe("json_schema");
    expect(attendant!.model).toBe(MODELS.attendant);
    expect(attendant!.tools?.map((t) => ("name" in t ? t.name : t.type))).toEqual([
      "info_clinica",
      "listar_horarios",
      "reservar",
      "minhas_consultas",
      "remarcar",
      "cancelar",
      "transferir_humano",
    ]);
    // Static system prompt is cached; volatile facts go in a trailing system message.
    expect(JSON.stringify(attendant!.system)).toContain("ephemeral");
    // First contact: the privacy notice is stored after the patient's message, and the
    // patient's message still goes to the model exactly once.
    expect(attendant!.messages.filter((m) => m.content === "quero marcar")).toHaveLength(1);
    const last = attendant!.messages.at(-1)!;
    expect(last.role).toBe("system");
    expect(String(last.content)).toContain("2026-10-19");
  });

  it("does not run the attendant when deterministic safety already answered", async () => {
    const llm = new ScriptedLlm();
    const { deps, channel } = makeDeps({ llm });
    await deliver(textPayload("estou com muita dor, posso tomar ibuprofeno?"), deps);
    expect(llm.requests).toHaveLength(0);
    expect(previewText(channel.outbox.at(-1)!)).toContain("Não consigo dar orientações clínicas");
  });

  it("falls back to the front desk when the clinic has no agenda (tenant mismatch)", async () => {
    const llm = new ScriptedLlm().route("agenda");
    const { deps, channel, store } = makeDeps({ llm });
    deps.ai = { ...deps.ai!, agendaFor: async () => null };
    await deliver(textPayload("quero marcar"), deps);
    expect(previewText(channel.outbox.at(-1)!)).toContain("recepção");
    expect([...store.conversations.values()][0]!.botPausedUntil).not.toBeNull();
  });

  it("returns invalid tool input to the model as an error instead of running it", async () => {
    const llm = new ScriptedLlm()
      .route("agenda")
      .push({ tool: "listar_horarios", input: { procedimento: "limpeza", clinicId: "outra" } })
      .push({ text: "Pode repetir o procedimento?" });
    const { deps } = makeDeps({ llm });
    await deliver(textPayload("quero marcar limpeza"), deps);
    const toolResult = llm.requests[2]!.messages.at(-1)!;
    expect(JSON.stringify(toolResult.content)).toContain('"is_error":true');
  });

  it("links the patient record to the conversation after booking", async () => {
    const llm = new ScriptedLlm()
      .route("agenda")
      .push({ tool: "listar_horarios", input: { procedimento: "avaliação" } })
      .push({ tool: "reservar", input: { opcao: 1, nome_completo: "Paciente Exemplo" } })
      .push({ text: "Pronto, consulta marcada!" });
    const { deps, store, agendaRepo } = makeDeps({ llm });
    await deliver(textPayload("marca a primeira avaliação que tiver, sou Paciente Exemplo"), deps);
    const conv = [...store.conversations.values()][0]!;
    expect(agendaRepo.appointments).toHaveLength(1);
    expect(conv.patientId).toBe(agendaRepo.appointments[0]!.patientId);
    expect(conv.agentState).toMatchObject({ offers: [] });
  });
});
