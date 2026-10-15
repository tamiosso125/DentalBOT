import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { buildAgendaMcpServer } from "./agenda-mcp.js";
import { AgendaService } from "./agenda-service.js";
import { demoAgendaSeed, InMemoryAgendaRepository } from "./memory-agenda.js";

// Monday 2026-10-19, 09:00 in São Paulo.
const now = () => new Date("2026-10-19T12:00:00Z");

async function connect() {
  const repo = new InMemoryAgendaRepository(demoAgendaSeed("clinic_test"));
  const server = buildAgendaMcpServer(new AgendaService(repo, { now }), { now });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);

  async function call(name: string, args: Record<string, unknown> = {}) {
    const res = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    const text = res.content[0]!.text;
    return { error: res.isError === true, text, data: res.isError ? null : JSON.parse(text) };
  }
  return { client, call, repo };
}

describe("MCP dentalbot-agenda", () => {
  it("lists its tools", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "cancelar",
      "consultas_do_paciente",
      "info_agenda",
      "listar_horarios",
      "remarcar",
      "reservar",
    ]);
  });

  it("shows procedures with table prices and opening hours", async () => {
    const { call } = await connect();
    const { data } = await call("info_agenda");
    expect(data.procedimentos).toContainEqual(
      expect.objectContaining({ nome: "Avaliação", preco: "após avaliação" }),
    );
    expect(data.atendimento[0]).toEqual({ dia: "seg", inicio: "08:00", fim: "12:00" });
  });

  it("books, reschedules and cancels by number, masking the phone", async () => {
    const { call, repo } = await connect();
    const slots = await call("listar_horarios", { procedimento: "limpeza", dias: 3 });
    // 2h minimum notice: the first option on Monday 09:00 is 11:00.
    expect(slots.data.opcoes[0]).toEqual({ opcao: 1, quando: "seg 19/10 11:00" });

    const booked = await call("reservar", {
      opcao: 1,
      telefone: "11 90000-0005",
      nome: "Paciente Exemplo",
    });
    expect(booked.data).toMatchObject({ reservado: true, paciente: { telefone: "***0005" } });
    expect(booked.text).not.toContain("900000005");
    expect(repo.appointments).toHaveLength(1);

    // Option 1 is used; the others keep their numbers.
    expect((await call("reservar", { opcao: 1, telefone: "11 90000-0005" })).error).toBe(true);

    const mine = await call("consultas_do_paciente", { telefone: "5511900000005" });
    expect(mine.data.consultas).toHaveLength(1);

    await call("listar_horarios", { procedimento: "limpeza", a_partir_de: "2026-10-21" });
    const moved = await call("remarcar", { consulta: 1, opcao: 1, telefone: "11900000005" });
    expect(moved.data).toEqual({ remarcado: true, quando: "quarta-feira, 21/10 às 08:00" });

    expect((await call("cancelar", { consulta: 1, telefone: "11900000005" })).data).toEqual({
      cancelado: true,
    });
    expect(repo.appointments[0]!.status).toBe("CANCELLED");
  });

  it("refuses another patient's appointment, a new patient without name and bad input", async () => {
    const { call } = await connect();
    await call("listar_horarios", { procedimento: "limpeza" });
    expect((await call("reservar", { opcao: 1, telefone: "11900000006" })).text).toContain(
      "nome completo",
    );
    await call("reservar", { opcao: 1, telefone: "11900000006", nome: "Paciente Seis" });
    await call("consultas_do_paciente", { telefone: "11900000006" });
    const other = await call("cancelar", { consulta: 1, telefone: "11900000007" });
    expect(other).toMatchObject({ error: true });
    expect(other.text).toContain("não é deste paciente");

    expect((await call("reservar", { opcao: 99, telefone: "11900000006" })).error).toBe(true);
    expect((await call("consultas_do_paciente", { telefone: "123" })).error).toBe(true);
    expect((await call("listar_horarios", { procedimento: "implante" })).text).toContain(
      "não encontrado",
    );
  });

  it("does not move an appointment to another procedure's slot", async () => {
    const { call } = await connect();
    await call("listar_horarios", { procedimento: "limpeza" });
    await call("reservar", { opcao: 1, telefone: "11900000008", nome: "Paciente Oito" });
    await call("consultas_do_paciente", { telefone: "11900000008" });
    await call("listar_horarios", { procedimento: "canal" });
    const res = await call("remarcar", { consulta: 1, opcao: 1, telefone: "11900000008" });
    expect(res.text).toContain("outro procedimento");
  });
});
