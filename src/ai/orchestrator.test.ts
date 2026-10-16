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
      "informar_convenio",
      "entrar_lista_espera",
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

  it("tells the attendant which plans cover each procedure", async () => {
    const llm = new ScriptedLlm()
      .route("info")
      .push({ tool: "info_clinica", input: {} })
      .push({ text: "A extração é coberta pela Odontoprev, com autorização prévia." });
    const { deps } = makeDeps({ llm });
    await deliver(textPayload("odontoprev cobre extração?"), deps);
    const block = (llm.requests[2]!.messages.at(-1)!.content as Array<{ content?: unknown }>)[0]!;
    const info = JSON.parse(String(block.content)) as {
      procedimentos: Array<{ nome: string; coberto_pelos_convenios: unknown[] }>;
      convenios_sem_tabela_de_cobertura: string[];
    };
    const byName = Object.fromEntries(
      info.procedimentos.map((p) => [p.nome, p.coberto_pelos_convenios]),
    );
    expect(byName["Extração simples"]).toEqual([
      { convenio: "Odontoprev", autorizacao_previa: true },
    ]);
    expect(byName["Limpeza (profilaxia)"]).toEqual([
      { convenio: "Odontoprev", autorizacao_previa: false },
    ]);
    expect(byName["Tratamento de canal"]).toEqual([]);
    expect(info.convenios_sem_tabela_de_cobertura).toEqual([]);
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

  it("puts the patient on the waiting list until the day before the first free slot", async () => {
    const llm = new ScriptedLlm()
      .route("agenda")
      .push({
        tool: "entrar_lista_espera",
        input: { procedimento: "avaliação", nome_completo: "Paciente Exemplo" },
      })
      .push({ text: "Pronto! Se abrir uma vaga até quarta-feira, 21/10, te aviso por aqui." })
      .route("agenda")
      .push({ tool: "entrar_lista_espera", input: { procedimento: "avaliação" } })
      .push({ text: "Você já está na lista." });
    const { deps, agendaRepo, waitlistRepo } = makeDeps({ llm });
    // Monday to Wednesday are full: the first free evaluation is on Thursday 22/10.
    agendaRepo.addBlock({
      dentistId: "dentist_dev",
      startsAt: new Date("2026-10-19T03:00:00Z"),
      endsAt: new Date("2026-10-22T03:00:00Z"),
    });
    await deliver(textPayload("não tem nada mais cedo? me coloca na lista de espera"), deps);
    const result = (r: number) =>
      JSON.parse(
        String(
          (llm.requests[r]!.messages.at(-1)!.content as Array<{ content?: unknown }>)[0]!.content,
        ),
      ) as Record<string, unknown>;
    expect(result(2)).toMatchObject({
      ok: true,
      procedimento: "Avaliação",
      ja_estava_na_lista: false,
      avisamos_vagas_ate: "quarta-feira, 21/10",
    });
    expect(waitlistRepo.entries).toEqual([
      expect.objectContaining({
        procedureId: "proc_avaliacao",
        until: new Date("2026-10-22T03:00:00Z"),
        status: "WAITING",
      }),
    ]);
    await deliver(textPayload("me coloca na lista de espera de novo"), deps);
    expect(result(5)).toMatchObject({ ja_estava_na_lista: true });
    expect(waitlistRepo.entries).toHaveLength(1);
  });

  it("does not use the waiting list when there is a slot tomorrow", async () => {
    const llm = new ScriptedLlm()
      .route("agenda")
      .push({
        tool: "entrar_lista_espera",
        input: { procedimento: "avaliação", nome_completo: "Paciente Exemplo" },
      })
      .push({ text: "Tem horário já amanhã, quer ver?" });
    const { deps, waitlistRepo } = makeDeps({ llm });
    await deliver(textPayload("quero entrar na lista de espera para avaliação"), deps);
    expect(JSON.stringify(llm.requests[2]!.messages.at(-1)!.content)).toContain(
      "listar_horarios em vez da lista de espera",
    );
    expect(waitlistRepo.entries).toEqual([]);
  });

  it("registers the plan and card, then flags the authorization when booking", async () => {
    const llm = new ScriptedLlm()
      .route("agenda")
      .push({
        tool: "informar_convenio",
        input: { convenio: "Amil", carteirinha: "123456789", nome_completo: "Paciente Exemplo" },
      })
      .push({
        tool: "informar_convenio",
        input: { convenio: "Odontoprev", carteirinha: "1234-56789" },
      })
      .push({ tool: "listar_horarios", input: { procedimento: "extração" } })
      .push({ tool: "reservar", input: { opcao: 1 } })
      .push({ text: "Pronto! A recepção pede a autorização à Odontoprev e avisa por aqui." });
    const { deps, insuranceRepo, agendaRepo } = makeDeps({ llm });
    await deliver(textPayload("extração pela Odontoprev, carteirinha 1234-56789"), deps);
    // Every tool result of the turn, in order.
    const results = llm.requests
      .at(-1)!
      .messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .flatMap((b) =>
        b.type === "tool_result" ? [JSON.parse(String(b.content)) as Record<string, unknown>] : [],
      );
    expect(results[0]).toMatchObject({ convenios_aceitos: ["Odontoprev"] });
    expect(results[1]).toMatchObject({ ok: true, convenio: "Odontoprev" });
    expect(results[3]).toMatchObject({ ok: true, autorizacao_previa: expect.any(String) });
    const patientId = agendaRepo.appointments[0]!.patientId;
    expect(insuranceRepo.patientPlans.get(patientId)).toEqual({
      planId: "plan_odontoprev",
      card: "123456789",
    });
  });
});
