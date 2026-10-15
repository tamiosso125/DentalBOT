import type { PrismaClient, QuoteStatus } from "@prisma/client";
import { z } from "zod";
import { maskPhone, normalizePhone, type FieldCipher } from "../privacy/index.js";
import { addDays, zonedToUtc } from "../scheduling/time.js";

/** Read side of the staff panel. Every query is scoped by clinic id. */

export type AgendaRow = {
  id: string;
  startsAt: string;
  endsAt: string;
  status: string;
  procedureName: string;
  dentistName: string;
  patientId: string;
  patientName: string;
  /** Last 4 digits only. */
  patientPhone: string;
};

export type AppointmentDetail = AgendaRow & { procedureId: string; dentistId: string };

export type PatientRow = { id: string; name: string; phone: string };

export type Catalog = {
  timeZone: string;
  dentists: Array<{ id: string; name: string; cro: string | null }>;
  procedures: Array<{
    id: string;
    name: string;
    durationMinutes: number;
    priceCents: number | null;
  }>;
};

export type QuoteRow = {
  id: string;
  status: string;
  patientName: string;
  totalCents: number;
  installmentCount: number;
  validUntil: string | null;
  createdAt: string;
  sentAt: string | null;
  respondedAt: string | null;
};

export type HandoffRow = {
  conversationId: string;
  contact: string;
  patientName: string | null;
  pausedUntil: string;
  lastInboundAt: string | null;
};

export const agendaQuerySchema = z.strictObject({
  from: z.iso.date(),
  days: z.coerce.number().int().min(1).max(31).default(7),
});

export const patientQuerySchema = z.strictObject({ q: z.string().trim().min(2).max(80) });

export const quoteQuerySchema = z.strictObject({
  status: z.enum(["DRAFT", "SENT", "ACCEPTED", "REJECTED", "EXPIRED"]).optional(),
});

export interface PanelQueries {
  agenda(clinicId: string, q: z.infer<typeof agendaQuerySchema>): Promise<AgendaRow[]>;
  appointment(clinicId: string, id: string): Promise<AppointmentDetail | null>;
  patients(clinicId: string, q: string): Promise<PatientRow[]>;
  catalog(clinicId: string): Promise<Catalog | null>;
  quotes(clinicId: string, status?: QuoteStatus): Promise<QuoteRow[]>;
  handoffs(clinicId: string, now: Date): Promise<HandoffRow[]>;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const dateOnly = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

export class PrismaPanelQueries implements PanelQueries {
  constructor(
    private readonly db: PrismaClient,
    private readonly cipher: FieldCipher,
  ) {}

  private phone(encrypted: string) {
    return maskPhone(this.cipher.decrypt(encrypted));
  }

  async agenda(clinicId: string, q: z.infer<typeof agendaQuerySchema>) {
    const clinic = await this.db.clinic.findUnique({
      where: { id: clinicId },
      select: { timezone: true },
    });
    if (!clinic) return [];
    // Day boundaries in the clinic's timezone, not UTC.
    const from = zonedToUtc(q.from, 0, clinic.timezone);
    const to = zonedToUtc(addDays(q.from, q.days), 0, clinic.timezone);
    const rows = await this.db.appointment.findMany({
      where: { clinicId, startsAt: { gte: from, lt: to } },
      orderBy: { startsAt: "asc" },
      include: {
        patient: { select: { id: true, name: true, phoneEncrypted: true } },
        procedure: { select: { name: true } },
        dentist: { select: { name: true } },
      },
    });
    return rows.map((a) => ({
      id: a.id,
      startsAt: a.startsAt.toISOString(),
      endsAt: a.endsAt.toISOString(),
      status: a.status,
      procedureName: a.procedure.name,
      dentistName: a.dentist.name,
      patientId: a.patient.id,
      patientName: a.patient.name,
      patientPhone: this.phone(a.patient.phoneEncrypted),
    }));
  }

  async appointment(clinicId: string, id: string) {
    const a = await this.db.appointment.findFirst({
      where: { id, clinicId },
      include: {
        patient: { select: { id: true, name: true, phoneEncrypted: true } },
        procedure: { select: { name: true } },
        dentist: { select: { name: true } },
      },
    });
    if (!a) return null;
    return {
      id: a.id,
      startsAt: a.startsAt.toISOString(),
      endsAt: a.endsAt.toISOString(),
      status: a.status,
      procedureId: a.procedureId,
      procedureName: a.procedure.name,
      dentistId: a.dentistId,
      dentistName: a.dentist.name,
      patientId: a.patient.id,
      patientName: a.patient.name,
      patientPhone: this.phone(a.patient.phoneEncrypted),
    };
  }

  async patients(clinicId: string, q: string) {
    // A phone is matched exactly through its hash; anything else searches the name.
    let phoneHash: string | undefined;
    if (/^[\d\s()+-]+$/.test(q)) {
      try {
        phoneHash = this.cipher.hash(normalizePhone(q));
      } catch {
        return [];
      }
    }
    const rows = await this.db.patient.findMany({
      where: phoneHash
        ? { clinicId, phoneHash }
        : { clinicId, name: { contains: q, mode: "insensitive" } },
      orderBy: { name: "asc" },
      take: 20,
      select: { id: true, name: true, phoneEncrypted: true },
    });
    return rows.map((p) => ({ id: p.id, name: p.name, phone: this.phone(p.phoneEncrypted) }));
  }

  async catalog(clinicId: string) {
    const clinic = await this.db.clinic.findUnique({
      where: { id: clinicId },
      select: {
        timezone: true,
        dentists: { where: { active: true }, select: { id: true, name: true, cro: true } },
        procedures: {
          where: { active: true },
          orderBy: { name: "asc" },
          select: { id: true, name: true, durationMinutes: true, priceCents: true },
        },
      },
    });
    return clinic
      ? { timeZone: clinic.timezone, dentists: clinic.dentists, procedures: clinic.procedures }
      : null;
  }

  async quotes(clinicId: string, status?: QuoteStatus) {
    const rows = await this.db.quote.findMany({
      where: { clinicId, ...(status ? { status } : {}) },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { patient: { select: { name: true } } },
    });
    return rows.map((q) => ({
      id: q.id,
      status: q.status,
      patientName: q.patient.name,
      totalCents: q.totalCents,
      installmentCount: q.installmentCount,
      validUntil: dateOnly(q.validUntil),
      createdAt: q.createdAt.toISOString(),
      sentAt: iso(q.sentAt),
      respondedAt: iso(q.respondedAt),
    }));
  }

  async handoffs(clinicId: string, now: Date) {
    const rows = await this.db.conversation.findMany({
      where: { clinicId, botPausedUntil: { gt: now } },
      orderBy: { lastInboundAt: "desc" },
      take: 100,
      include: { patient: { select: { name: true } } },
    });
    return rows.map((c) => ({
      conversationId: c.id,
      contact: this.phone(c.contactEncrypted),
      patientName: c.patient?.name ?? null,
      pausedUntil: c.botPausedUntil!.toISOString(),
      lastInboundAt: iso(c.lastInboundAt),
    }));
  }
}
