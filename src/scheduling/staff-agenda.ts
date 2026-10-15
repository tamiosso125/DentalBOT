import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { ConversationStore } from "../conversation/store.js";
import type { Logger } from "../lib/logger.js";
import { normalizePhone, type FieldCipher } from "../privacy/index.js";
import { previewText, type OutboundMessage, type WhatsAppChannel } from "../whatsapp/index.js";
import { AppointmentNotFoundError, SlotUnavailableError, type Slot } from "./agenda-provider.js";
import { AgendaService, type AgendaRepository } from "./agenda-service.js";
import { appointmentButtons } from "./appointment-reminders.js";
import { PrismaAgendaRepository } from "./prisma-agenda.js";
import { addDays, dateInZone, formatWhenPtBr } from "./time.js";

/** Front desk changes to the agenda, from the staff panel (`/admin/*`). */

export const slotsQuerySchema = z.strictObject({
  procedureId: z.string().min(1).max(64),
  from: z.iso.date(),
  days: z.coerce.number().int().min(1).max(14).default(1),
});

const when = {
  dentistId: z.string().min(1).max(64),
  startsAt: z.iso.datetime(),
  /** Send the confirmacao_consulta template to the patient. */
  notify: z.boolean().default(true),
};

export const bookSchema = z.strictObject({
  patient: z.union([
    z.strictObject({ id: z.string().min(1).max(64) }),
    z.strictObject({ name: z.string().trim().min(3).max(120), phone: z.string().max(30) }),
  ]),
  procedureId: z.string().min(1).max(64),
  ...when,
});

export const rescheduleSchema = z.strictObject(when);

/** A request the front desk can fix (shown in the panel). `status` is the HTTP code. */
export class StaffAgendaError extends Error {
  constructor(
    readonly status: 404 | 409 | 422,
    message: string,
  ) {
    super(message);
    this.name = "StaffAgendaError";
  }
}

export type StaffSlot = { dentistId: string; startsAt: string; endsAt: string };

export type StaffAgendaContext = {
  agenda: AgendaService;
  repo: AgendaRepository;
  clinicName: string;
};

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/**
 * Lets the front desk book, move and cancel appointments with the same rules the bot
 * follows (working hours, no double booking). The only difference: staff may book with
 * no minimum notice. Every call is scoped to one clinic.
 */
export class StaffAgenda {
  constructor(
    private readonly deps: {
      open: (clinicId: string) => Promise<StaffAgendaContext | null>;
      channel: WhatsAppChannel;
      store: ConversationStore;
      logger: Logger;
      now?: () => Date;
    },
  ) {}

  async slots(clinicId: string, input: unknown): Promise<StaffSlot[]> {
    const q = parse(slotsQuerySchema, input);
    const { agenda } = await this.ctx(clinicId);
    const slots = await agenda.listarHorarios(q);
    return slots.map((s) => ({
      dentistId: s.dentistId,
      startsAt: s.startsAt.toISOString(),
      endsAt: s.endsAt.toISOString(),
    }));
  }

  async book(clinicId: string, input: unknown): Promise<{ id: string; notified: boolean }> {
    const body = parse(bookSchema, input);
    const ctx = await this.ctx(clinicId);
    const patient = await this.patient(ctx, body.patient);
    const slot = await this.slot(ctx, body.procedureId, body.dentistId, body.startsAt);
    const { appointmentId } = await mapErrors(() =>
      ctx.agenda.reservar({ patientId: patient.id, slot }),
    );
    this.deps.logger.info({ appointmentId }, "appointment booked by staff");
    const notified = body.notify
      ? await this.notify(ctx, clinicId, patient, appointmentId, slot)
      : false;
    return { id: appointmentId, notified };
  }

  async reschedule(
    clinicId: string,
    appointmentId: string,
    input: unknown,
  ): Promise<{ notified: boolean }> {
    const body = parse(rescheduleSchema, input);
    const ctx = await this.ctx(clinicId);
    const owner = await ctx.repo.appointmentOwner(appointmentId);
    if (!owner || owner.status === "CANCELLED")
      throw new StaffAgendaError(404, "Consulta não encontrada.");
    const slot = await this.slot(ctx, owner.procedureId, body.dentistId, body.startsAt);
    await mapErrors(() => ctx.agenda.remarcar({ appointmentId, patientId: owner.patientId, slot }));
    this.deps.logger.info({ appointmentId }, "appointment moved by staff");
    const patient = await ctx.repo.patientById(owner.patientId);
    const notified =
      body.notify && patient
        ? await this.notify(ctx, clinicId, patient, appointmentId, slot)
        : false;
    return { notified };
  }

  async cancel(clinicId: string, appointmentId: string): Promise<void> {
    const ctx = await this.ctx(clinicId);
    const owner = await ctx.repo.appointmentOwner(appointmentId);
    if (!owner) throw new StaffAgendaError(404, "Consulta não encontrada.");
    await mapErrors(() => ctx.agenda.cancelar({ appointmentId, patientId: owner.patientId }));
    this.deps.logger.info({ appointmentId }, "appointment cancelled by staff");
  }

  private async ctx(clinicId: string) {
    const ctx = await this.deps.open(clinicId);
    if (!ctx) throw new StaffAgendaError(404, "Clínica não encontrada.");
    return ctx;
  }

  private async patient(
    ctx: StaffAgendaContext,
    ref: z.infer<typeof bookSchema>["patient"],
  ): Promise<{ id: string; name: string; phone: string }> {
    if ("id" in ref) {
      const p = await ctx.repo.patientById(ref.id);
      if (!p) throw new StaffAgendaError(404, "Paciente não encontrado.");
      return p;
    }
    let phone: string;
    try {
      phone = normalizePhone(ref.phone);
    } catch {
      throw new StaffAgendaError(422, "Celular inválido. Use DDD + número.");
    }
    // Same number as an existing patient: reuse that record.
    const p =
      (await ctx.agenda.buscarPaciente({ phone })) ??
      (await ctx.agenda.cadastrarPaciente({ name: ref.name, phone }));
    return { ...p, phone };
  }

  private async slot(
    ctx: StaffAgendaContext,
    procedureId: string,
    dentistId: string,
    startsAtIso: string,
  ): Promise<Slot> {
    const procedure = (await ctx.agenda.listarProcedimentos()).find((p) => p.id === procedureId);
    if (!procedure) throw new StaffAgendaError(422, "Procedimento não encontrado.");
    const startsAt = new Date(startsAtIso);
    return {
      dentistId,
      procedureId,
      startsAt,
      endsAt: new Date(startsAt.getTime() + procedure.durationMinutes * 60_000),
    };
  }

  /**
   * Tells the patient the new date by the approved template, with Confirmar/Remarcar. If
   * the appointment is today or tomorrow, this message also takes the place of the
   * day-before reminder. A failed send never undoes the booking.
   */
  private async notify(
    ctx: StaffAgendaContext,
    clinicId: string,
    patient: { name: string; phone: string },
    appointmentId: string,
    slot: Slot,
  ): Promise<boolean> {
    const { channel, store, logger } = this.deps;
    const now = this.deps.now?.() ?? new Date();
    const tz = ctx.agenda.timeZone;
    try {
      const conv = await store.getOrCreateConversation(clinicId, patient.phone);
      const msg: OutboundMessage = {
        kind: "template",
        to: conv.contact,
        template: "confirmacao_consulta",
        params: [firstName(patient.name), ctx.clinicName, formatWhenPtBr(slot.startsAt, tz)],
        buttonPayloads: appointmentButtons(appointmentId),
      };
      const { waMessageId } = await channel.send(msg);
      await store.saveMessage({
        conversationId: conv.id,
        waMessageId,
        direction: "OUTBOUND",
        type: msg.kind,
        body: previewText(msg),
        at: now,
      });
      if (dateInZone(slot.startsAt, tz) <= addDays(dateInZone(now, tz), 1))
        await ctx.repo.markReminderSent(appointmentId, now);
      return true;
    } catch (err) {
      logger.error(
        { appointmentId, err: err instanceof Error ? err.message : "unknown" },
        "appointment notice failed",
      );
      return false;
    }
  }
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new StaffAgendaError(422, "Dados inválidos.");
  return r.data;
}

async function mapErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof SlotUnavailableError)
      throw new StaffAgendaError(409, "Esse horário não está mais livre. Escolha outro.");
    if (err instanceof AppointmentNotFoundError)
      throw new StaffAgendaError(404, "Consulta não encontrada.");
    throw err;
  }
}

/** Staff agenda over Postgres. No minimum notice: the front desk may fit someone in now. */
export function prismaStaffAgendaOpener(db: PrismaClient, cipher: FieldCipher) {
  return async (clinicId: string): Promise<StaffAgendaContext | null> => {
    const clinic = await db.clinic.findUnique({
      where: { id: clinicId },
      select: { name: true, timezone: true },
    });
    if (!clinic) return null;
    const repo = new PrismaAgendaRepository(db, cipher, clinicId, clinic.timezone);
    return {
      agenda: new AgendaService(repo, { minNoticeMinutes: 0 }),
      repo,
      clinicName: clinic.name,
    };
  };
}
