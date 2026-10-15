import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { matchProcedure, openingTimes } from "../ai/tools.js";
import { formatCents } from "../lib/money.js";
import { maskPhone, normalizePhone } from "../privacy/index.js";
import {
  AppointmentNotFoundError,
  SlotUnavailableError,
  type AgendaProvider,
  type Slot,
} from "./agenda-provider.js";
import { addDays, dateInZone, formatShortPtBr, formatWhenPtBr } from "./time.js";

const WEEKDAYS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

type Result = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
const ok = (data: unknown): Result => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
});
const fail = (message: string): Result => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

const phoneSchema = z
  .string()
  .min(10)
  .max(20)
  .describe("Celular do paciente com DDD, ex.: 11 90000-0001");

/**
 * MCP server "dentalbot-agenda" for the team's Claude Code: look at and change the agenda
 * through the same AgendaProvider the WhatsApp attendant uses (same rules: notice period,
 * no double booking, only the patient's own appointments).
 *
 * Like the attendant, it never takes a time typed by hand: `listar_horarios` and
 * `consultas_do_paciente` return numbered options, and the write tools pick by number.
 * Phones are masked in every answer.
 */
export function buildAgendaMcpServer(agenda: AgendaProvider, opts: { now?: () => Date } = {}) {
  const now = opts.now ?? (() => new Date());
  const tz = agenda.timeZone;
  // Numbering stays stable after a booking or cancel: used entries become null.
  let offers: Array<Slot | null> = [];
  let appointments: Array<{ id: string; phone: string; procedureId: string } | null> = [];

  const server = new McpServer({ name: "dentalbot-agenda", version: "0.1.0" });

  async function patientByPhone(raw: string) {
    let phone: string;
    try {
      phone = normalizePhone(raw);
    } catch {
      return { error: fail("Telefone inválido. Use DDD + número, ex.: 11 90000-0001.") };
    }
    return { phone, patient: await agenda.buscarPaciente({ phone }) };
  }

  server.registerTool(
    "info_agenda",
    {
      description: "Procedimentos (duração e preço da tabela) e horário de atendimento da clínica.",
      inputSchema: {},
    },
    async () => {
      const [procedures, hours] = await Promise.all([
        agenda.listarProcedimentos(),
        agenda.horariosDeAtendimento(),
      ]);
      return ok({
        fusoHorario: tz,
        procedimentos: procedures.map((p) => ({
          id: p.id,
          nome: p.name,
          duracaoMinutos: p.durationMinutes,
          preco: p.priceCents === null ? "após avaliação" : formatCents(p.priceCents),
        })),
        atendimento: hours.map((h) => {
          const [inicio, fim] = openingTimes([h]);
          return { dia: WEEKDAYS[h.weekday], inicio, fim };
        }),
      });
    },
  );

  server.registerTool(
    "listar_horarios",
    {
      description:
        "Horários livres de um procedimento. Devolve opções numeradas para reservar ou remarcar.",
      inputSchema: {
        procedimento: z.string().min(2).describe("Nome ou id do procedimento"),
        a_partir_de: z.iso.date().optional().describe("YYYY-MM-DD; padrão: hoje"),
        dias: z.number().int().min(1).max(14).default(5),
        limite: z.number().int().min(1).max(30).default(10),
      },
    },
    async ({ procedimento, a_partir_de, dias, limite }) => {
      const procedures = await agenda.listarProcedimentos();
      const proc =
        procedures.find((p) => p.id === procedimento) ?? matchProcedure(procedures, procedimento);
      if (!proc)
        return fail(
          `Procedimento não encontrado. Opções: ${procedures.map((p) => p.name).join(", ")}.`,
        );
      const from = a_partir_de ?? dateInZone(now(), tz);
      const slots = (await agenda.listarHorarios({ procedureId: proc.id, from, days: dias })).slice(
        0,
        limite,
      );
      offers = slots;
      return ok({
        procedimento: proc.name,
        de: from,
        ate: addDays(from, dias - 1),
        opcoes: slots.map((s, i) => ({ opcao: i + 1, quando: formatShortPtBr(s.startsAt, tz) })),
      });
    },
  );

  server.registerTool(
    "reservar",
    {
      description:
        "Reserva uma opção de listar_horarios para o paciente. Cadastra o paciente se for novo (precisa do nome).",
      inputSchema: {
        opcao: z.number().int().min(1),
        telefone: phoneSchema,
        nome: z.string().min(3).max(120).optional().describe("Obrigatório para paciente novo"),
      },
    },
    async ({ opcao, telefone, nome }) => {
      const slot = offers[opcao - 1];
      if (!slot) return fail("Opção inexistente. Chame listar_horarios antes.");
      const found = await patientByPhone(telefone);
      if (found.error) return found.error;
      let patient = found.patient;
      if (!patient) {
        if (!nome) return fail("Paciente novo: informe o nome completo.");
        patient = await agenda.cadastrarPaciente({ name: nome, phone: found.phone });
      }
      try {
        const { appointmentId } = await agenda.reservar({ patientId: patient.id, slot });
        offers[opcao - 1] = null;
        return ok({
          reservado: true,
          consultaId: appointmentId,
          paciente: { nome: patient.name, telefone: maskPhone(found.phone) },
          quando: formatWhenPtBr(slot.startsAt, tz),
        });
      } catch (err) {
        if (err instanceof SlotUnavailableError)
          return fail("Esse horário acabou de ser ocupado. Chame listar_horarios de novo.");
        throw err;
      }
    },
  );

  server.registerTool(
    "consultas_do_paciente",
    {
      description: "Próximas consultas do paciente, numeradas para remarcar ou cancelar.",
      inputSchema: { telefone: phoneSchema },
    },
    async ({ telefone }) => {
      const found = await patientByPhone(telefone);
      if (found.error) return found.error;
      if (!found.patient)
        return ok({ telefone: maskPhone(found.phone), paciente: null, consultas: [] });
      const list = await agenda.consultasDoPaciente({ patientId: found.patient.id, from: now() });
      appointments = list.map((a) => ({
        id: a.id,
        phone: found.phone,
        procedureId: a.procedureId,
      }));
      return ok({
        paciente: { nome: found.patient.name, telefone: maskPhone(found.phone) },
        consultas: list.map((a, i) => ({
          consulta: i + 1,
          procedimento: a.procedureName,
          dentista: a.dentistName,
          quando: formatWhenPtBr(a.startsAt, tz),
          status: a.status,
        })),
      });
    },
  );

  async function ownAppointment(consulta: number, telefone: string) {
    const a = appointments[consulta - 1];
    if (!a) return { error: fail("Consulta inexistente. Chame consultas_do_paciente antes.") };
    const found = await patientByPhone(telefone);
    if (found.error) return { error: found.error };
    if (!found.patient || found.phone !== a.phone)
      return { error: fail("Essa consulta não é deste paciente.") };
    return { appointment: a, patient: found.patient };
  }

  server.registerTool(
    "remarcar",
    {
      description:
        "Move uma consulta (de consultas_do_paciente) para uma opção de listar_horarios do mesmo procedimento.",
      inputSchema: {
        consulta: z.number().int().min(1),
        opcao: z.number().int().min(1),
        telefone: phoneSchema,
      },
    },
    async ({ consulta, opcao, telefone }) => {
      const own = await ownAppointment(consulta, telefone);
      if (own.error) return own.error;
      const slot = offers[opcao - 1];
      if (!slot) return fail("Opção inexistente. Chame listar_horarios antes.");
      if (slot.procedureId !== own.appointment.procedureId)
        return fail("A opção é de outro procedimento. Liste horários do mesmo procedimento.");
      try {
        await agenda.remarcar({
          appointmentId: own.appointment.id,
          patientId: own.patient.id,
          slot,
        });
      } catch (err) {
        if (err instanceof SlotUnavailableError)
          return fail("Esse horário acabou de ser ocupado. Chame listar_horarios de novo.");
        if (err instanceof AppointmentNotFoundError) return fail("Consulta não encontrada.");
        throw err;
      }
      offers[opcao - 1] = null;
      return ok({ remarcado: true, quando: formatWhenPtBr(slot.startsAt, tz) });
    },
  );

  server.registerTool(
    "cancelar",
    {
      description: "Cancela uma consulta de consultas_do_paciente.",
      inputSchema: {
        consulta: z.number().int().min(1),
        telefone: phoneSchema,
        motivo: z.string().max(200).optional(),
      },
    },
    async ({ consulta, telefone, motivo }) => {
      const own = await ownAppointment(consulta, telefone);
      if (own.error) return own.error;
      try {
        await agenda.cancelar({
          appointmentId: own.appointment.id,
          patientId: own.patient.id,
          reason: motivo,
        });
      } catch (err) {
        if (err instanceof AppointmentNotFoundError) return fail("Consulta não encontrada.");
        throw err;
      }
      appointments[consulta - 1] = null;
      return ok({ cancelado: true });
    },
  );

  return server;
}
