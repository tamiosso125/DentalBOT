import type { PrismaClient, QuoteStatus } from "@prisma/client";
import { z } from "zod";
import { nameMatches, parseBirthDate } from "../lib/search-text.js";
import { maskPhone, normalizePhone, type FieldCipher } from "../privacy/index.js";
import { addDays, dateInZone, zonedToUtc } from "../scheduling/time.js";
import { medicalAlerts, openMedicalHistory } from "./medical-history.js";

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

/** An agenda row with the health warnings from the patient's current anamnesis. */
export type AgendaDayRow = AgendaRow & { medicalAlerts: string[] };

export type AppointmentDetail = AgendaRow & {
  procedureId: string;
  dentistId: string;
  /** From the patient's current medical history (anamnese). */
  medicalAlerts: string[];
};

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

/** Quotes still waiting for the patient, and how this month's answered ones went. */
export type QuoteFollowUp = {
  waiting: Array<{
    id: string;
    patientName: string;
    totalCents: number;
    sentAt: string;
    /** When the one follow-up reminder went out (null = not yet). */
    reminderSentAt: string | null;
    validUntil: string | null;
  }>;
  /** By answer date, in the clinic's month. */
  month: { accepted: number; rejected: number; expired: number };
};

export type HandoffRow = {
  conversationId: string;
  contact: string;
  patientName: string | null;
  pausedUntil: string;
  lastInboundAt: string | null;
};

/** Past appointments the front desk has not marked yet, and this month's attendance. */
export type Attendance = {
  pending: AgendaRow[];
  month: {
    attended: number;
    noShow: number;
    /** "We missed you" messages sent this month (consulta_perdida). */
    noShowNotices: number;
    /** Of those, patients who booked again (not cancelled) after the message. */
    rebooked: number;
  };
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
  agenda(clinicId: string, q: z.infer<typeof agendaQuerySchema>): Promise<AgendaDayRow[]>;
  appointment(clinicId: string, id: string): Promise<AppointmentDetail | null>;
  patients(clinicId: string, q: string): Promise<PatientRow[]>;
  catalog(clinicId: string): Promise<Catalog | null>;
  quotes(clinicId: string, status?: QuoteStatus): Promise<QuoteRow[]>;
  handoffs(clinicId: string, now: Date): Promise<HandoffRow[]>;
  attendance(clinicId: string, now: Date): Promise<Attendance>;
  quoteFollowUp(clinicId: string, now: Date): Promise<QuoteFollowUp>;
}

/** Names read per search; one clinic stays far below this. */
const NAME_SEARCH_SCAN = 5000;

/** Unmarked appointments older than this stop showing up as pending. */
const PENDING_DAYS = 30;

const agendaInclude = {
  patient: { select: { id: true, name: true, phoneEncrypted: true } },
  procedure: { select: { name: true } },
  dentist: { select: { name: true } },
} as const;

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
      include: agendaInclude,
    });
    const alerts = await this.alertsByPatient(clinicId, [
      ...new Set(rows.filter((a) => a.status !== "CANCELLED").map((a) => a.patient.id)),
    ]);
    return rows.map((a) => ({
      ...this.agendaRow(a),
      medicalAlerts: alerts.get(a.patient.id) ?? [],
    }));
  }

  /** Warnings from each patient's newest anamnesis; patients without one are left out. */
  private async alertsByPatient(clinicId: string, patientIds: string[]) {
    const out = new Map<string, string[]>();
    if (patientIds.length === 0) return out;
    const versions = await this.db.medicalHistory.findMany({
      where: { clinicId, patientId: { in: patientIds } },
      orderBy: { createdAt: "desc" },
      select: { patientId: true, dataEncrypted: true },
    });
    for (const v of versions) {
      if (out.has(v.patientId)) continue;
      out.set(v.patientId, medicalAlerts(openMedicalHistory(this.cipher, v.dataEncrypted)));
    }
    return out;
  }

  async attendance(clinicId: string, now: Date): Promise<Attendance> {
    const clinic = await this.db.clinic.findUnique({
      where: { id: clinicId },
      select: { timezone: true },
    });
    if (!clinic)
      return { pending: [], month: { attended: 0, noShow: 0, noShowNotices: 0, rebooked: 0 } };
    const monthStart = zonedToUtc(
      `${dateInZone(now, clinic.timezone).slice(0, 7)}-01`,
      0,
      clinic.timezone,
    );
    const [pending, counts, notices] = await Promise.all([
      this.db.appointment.findMany({
        where: {
          clinicId,
          status: { in: ["PENDING_CONFIRMATION", "CONFIRMED"] },
          startsAt: { gte: new Date(now.getTime() - PENDING_DAYS * 86_400_000), lt: now },
        },
        orderBy: { startsAt: "asc" },
        take: 50,
        include: agendaInclude,
      }),
      this.db.appointment.groupBy({
        by: ["status"],
        where: {
          clinicId,
          status: { in: ["COMPLETED", "NO_SHOW"] },
          startsAt: { gte: monthStart, lt: now },
        },
        _count: true,
      }),
      this.db.appointment.findMany({
        where: { clinicId, noShowNoticeAt: { gte: monthStart, lte: now } },
        select: { id: true, patientId: true, noShowNoticeAt: true },
      }),
    ]);
    const count = (s: string) => counts.find((c) => c.status === s)?._count ?? 0;
    const later = notices.length
      ? await this.db.appointment.findMany({
          where: {
            clinicId,
            patientId: { in: notices.map((n) => n.patientId) },
            status: { not: "CANCELLED" },
            createdAt: { gte: monthStart },
          },
          select: { id: true, patientId: true, createdAt: true },
        })
      : [];
    const rebooked = notices.filter((n) =>
      later.some(
        (a) => a.id !== n.id && a.patientId === n.patientId && a.createdAt > n.noShowNoticeAt!,
      ),
    ).length;
    return {
      pending: pending.map((a) => this.agendaRow(a)),
      month: {
        attended: count("COMPLETED"),
        noShow: count("NO_SHOW"),
        noShowNotices: notices.length,
        rebooked,
      },
    };
  }

  async quoteFollowUp(clinicId: string, now: Date): Promise<QuoteFollowUp> {
    const clinic = await this.db.clinic.findUnique({
      where: { id: clinicId },
      select: { timezone: true },
    });
    if (!clinic) return { waiting: [], month: { accepted: 0, rejected: 0, expired: 0 } };
    const monthStart = zonedToUtc(
      `${dateInZone(now, clinic.timezone).slice(0, 7)}-01`,
      0,
      clinic.timezone,
    );
    const [waiting, counts] = await Promise.all([
      this.db.quote.findMany({
        where: { clinicId, status: "SENT" },
        orderBy: { sentAt: "asc" },
        take: 100,
        include: { patient: { select: { name: true } } },
      }),
      this.db.quote.groupBy({
        by: ["status"],
        where: {
          clinicId,
          status: { in: ["ACCEPTED", "REJECTED", "EXPIRED"] },
          respondedAt: { gte: monthStart, lte: now },
        },
        _count: true,
      }),
    ]);
    const count = (s: string) => counts.find((c) => c.status === s)?._count ?? 0;
    return {
      waiting: waiting.map((q) => ({
        id: q.id,
        patientName: q.patient.name,
        totalCents: q.totalCents,
        sentAt: (q.sentAt ?? q.createdAt).toISOString(),
        reminderSentAt: iso(q.reminderSentAt),
        validUntil: dateOnly(q.validUntil),
      })),
      month: {
        accepted: count("ACCEPTED"),
        rejected: count("REJECTED"),
        expired: count("EXPIRED"),
      },
    };
  }

  private agendaRow(a: {
    id: string;
    startsAt: Date;
    endsAt: Date;
    status: string;
    procedure: { name: string };
    dentist: { name: string };
    patient: { id: string; name: string; phoneEncrypted: string };
  }): AgendaRow {
    return {
      id: a.id,
      startsAt: a.startsAt.toISOString(),
      endsAt: a.endsAt.toISOString(),
      status: a.status,
      procedureName: a.procedure.name,
      dentistName: a.dentist.name,
      patientId: a.patient.id,
      patientName: a.patient.name,
      patientPhone: this.phone(a.patient.phoneEncrypted),
    };
  }

  async appointment(clinicId: string, id: string) {
    const a = await this.db.appointment.findFirst({
      where: { id, clinicId },
      include: agendaInclude,
    });
    if (!a) return null;
    const history = await this.db.medicalHistory.findFirst({
      where: { clinicId, patientId: a.patientId },
      orderBy: { createdAt: "desc" },
      select: { dataEncrypted: true },
    });
    return {
      ...this.agendaRow(a),
      procedureId: a.procedureId,
      dentistId: a.dentistId,
      medicalAlerts: history
        ? medicalAlerts(openMedicalHistory(this.cipher, history.dataEncrypted))
        : [],
    };
  }

  async patients(clinicId: string, q: string) {
    const select = { id: true, name: true, phoneEncrypted: true } as const;
    const out = (rows: Array<{ id: string; name: string; phoneEncrypted: string }>) =>
      rows.map((p) => ({ id: p.id, name: p.name, phone: this.phone(p.phoneEncrypted) }));

    // A birth date (15/03/1990 or 1990-03-15) finds everyone born that day.
    const birth = parseBirthDate(q);
    if (birth) {
      return out(
        await this.db.patient.findMany({
          where: { clinicId, birthDate: new Date(`${birth}T00:00:00Z`), anonymizedAt: null },
          orderBy: { name: "asc" },
          take: 20,
          select,
        }),
      );
    }
    // A phone is matched exactly through its hash.
    if (/^[\d\s()+-]+$/.test(q)) {
      let phoneHash: string;
      try {
        phoneHash = this.cipher.hash(normalizePhone(q));
      } catch {
        return [];
      }
      return out(
        await this.db.patient.findMany({
          where: { clinicId, phoneHash },
          orderBy: { name: "asc" },
          take: 20,
          select,
        }),
      );
    }
    // Anything else searches the name, ignoring accents ("jose" finds "José"). One clinic has
    // a few thousand patients at most, so the names are filtered here, not with an extension.
    const rows = await this.db.patient.findMany({
      where: { clinicId, anonymizedAt: null },
      orderBy: { name: "asc" },
      take: NAME_SEARCH_SCAN,
      select,
    });
    return out(rows.filter((p) => nameMatches(p.name, q)).slice(0, 20));
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
