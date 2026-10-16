import type { PrismaClient } from "@prisma/client";
import { maskPhone, type FieldCipher } from "../privacy/index.js";

/**
 * Patient record for the staff panel: everything the clinic has about one patient on one
 * page (appointments, quotes and installments, payments at the front desk, insurance,
 * survey ratings, post-procedure answers, recall consent, waiting list). Read only, always
 * scoped by clinic, with the phone and the insurance card masked. CPF is never shown.
 */

export type PatientRecord = {
  patient: {
    id: string;
    name: string;
    /** Last 4 digits only. */
    phone: string;
    hasCpf: boolean;
    birthDate: string | null;
    createdAt: string;
    anonymizedAt: string | null;
  };
  insurance: {
    plan: string;
    /** Last 4 characters of the card, null if the card was not registered. */
    cardEnd: string | null;
  } | null;
  /** Latest answer about recall invitations; null = never asked. */
  recallConsent: { granted: boolean; at: string; source: string } | null;
  /** The patient answered PARAR (no marketing at all). */
  marketingOptOutAt: string | null;
  /** A person is handling the WhatsApp chat until then. */
  botPausedUntil: string | null;
  counts: { upcoming: number; attended: number; noShow: number; cancelled: number };
  /** Newest first, at most 50. */
  appointments: Array<{
    id: string;
    startsAt: string;
    status: string;
    procedure: string;
    dentist: string;
    authorization: "AUTHORIZED" | "DENIED" | null;
    surveyRating: number | null;
    aftercareAnswer: "OK" | "HELP" | null;
  }>;
  /** Newest first, at most 20. */
  quotes: Array<{
    id: string;
    status: string;
    totalCents: number;
    createdAt: string;
    installments: number;
    paidCents: number;
    openCents: number;
    overdue: number;
  }>;
  /** Amount still to be paid across all quotes, and how much of it is overdue. */
  balance: { openCents: number; overdueCents: number };
  /** Payments at the front desk outside a quote, newest first, at most 20. */
  clinicPayments: Array<{
    id: string;
    paidAt: string;
    amountCents: number;
    method: string;
    procedure: string | null;
  }>;
  /** Entries still waiting for a slot. */
  waitlist: Array<{ id: string; procedure: string; until: string }>;
};

const OPEN = ["PENDING", "BILLED", "OVERDUE"] as const;
const iso = (d: Date | null) => (d ? d.toISOString() : null);

export interface PatientRecords {
  record(clinicId: string, patientId: string, now: Date): Promise<PatientRecord | null>;
}

export class PrismaPatientRecords implements PatientRecords {
  constructor(
    private readonly db: PrismaClient,
    private readonly cipher: FieldCipher,
  ) {}

  async record(clinicId: string, patientId: string, now: Date): Promise<PatientRecord | null> {
    const p = await this.db.patient.findFirst({
      where: { id: patientId, clinicId },
      select: {
        id: true,
        name: true,
        phoneHash: true,
        phoneEncrypted: true,
        cpfHash: true,
        birthDate: true,
        createdAt: true,
        anonymizedAt: true,
        insuranceCardEncrypted: true,
        insurancePlan: { select: { name: true } },
      },
    });
    if (!p) return null;

    const [consent, conversation, statusCounts, appointments, quotes, payments, waitlist] =
      await Promise.all([
        this.db.consent.findFirst({
          where: { patientId, purpose: "MARKETING" },
          orderBy: { createdAt: "desc" },
          select: { granted: true, createdAt: true, source: true },
        }),
        this.db.conversation.findFirst({
          where: { clinicId, contactHash: p.phoneHash },
          select: { marketingOptOutAt: true, botPausedUntil: true },
        }),
        this.db.appointment.groupBy({
          by: ["status"],
          where: { clinicId, patientId },
          _count: { _all: true },
        }),
        this.db.appointment.findMany({
          where: { clinicId, patientId },
          orderBy: { startsAt: "desc" },
          take: 50,
          select: {
            id: true,
            startsAt: true,
            status: true,
            procedure: { select: { name: true } },
            dentist: { select: { name: true } },
            authorization: { select: { status: true } },
            survey: { select: { rating: true } },
            aftercare: { select: { answer: true } },
          },
        }),
        this.db.quote.findMany({
          where: { clinicId, patientId },
          orderBy: { createdAt: "desc" },
          take: 20,
          select: {
            id: true,
            status: true,
            totalCents: true,
            createdAt: true,
            installments: { select: { amountCents: true, status: true, dueDate: true } },
          },
        }),
        this.db.clinicPayment.findMany({
          where: { clinicId, patientId, voidedAt: null },
          orderBy: { paidAt: "desc" },
          take: 20,
          select: {
            id: true,
            paidAt: true,
            amountCents: true,
            method: true,
            procedure: { select: { name: true } },
          },
        }),
        this.db.waitlistEntry.findMany({
          where: { clinicId, patientId, status: "WAITING", until: { gt: now } },
          orderBy: { createdAt: "asc" },
          select: { id: true, until: true, procedure: { select: { name: true } } },
        }),
      ]);

    const count = (s: string) => statusCounts.find((c) => c.status === s)?._count._all ?? 0;
    const upcoming = await this.db.appointment.count({
      where: {
        clinicId,
        patientId,
        status: { in: ["PENDING_CONFIRMATION", "CONFIRMED"] },
        startsAt: { gte: now },
      },
    });

    const isOpen = (s: string) => (OPEN as readonly string[]).includes(s);
    // An installment past its due date counts as overdue even before Asaas says so.
    const isOverdue = (i: { status: string; dueDate: Date }) =>
      isOpen(i.status) && (i.status === "OVERDUE" || i.dueDate < now);
    const sum = (xs: Array<{ amountCents: number }>) => xs.reduce((a, x) => a + x.amountCents, 0);
    const allInstallments = quotes.flatMap((q) => q.installments);
    const card = p.insuranceCardEncrypted ? this.cipher.decrypt(p.insuranceCardEncrypted) : null;

    return {
      patient: {
        id: p.id,
        name: p.name,
        phone: maskPhone(this.cipher.decrypt(p.phoneEncrypted)),
        hasCpf: p.cpfHash !== null,
        birthDate: p.birthDate ? p.birthDate.toISOString().slice(0, 10) : null,
        createdAt: p.createdAt.toISOString(),
        anonymizedAt: iso(p.anonymizedAt),
      },
      insurance: p.insurancePlan
        ? { plan: p.insurancePlan.name, cardEnd: card ? card.slice(-4) : null }
        : null,
      recallConsent: consent
        ? { granted: consent.granted, at: consent.createdAt.toISOString(), source: consent.source }
        : null,
      marketingOptOutAt: iso(conversation?.marketingOptOutAt ?? null),
      botPausedUntil:
        conversation?.botPausedUntil && conversation.botPausedUntil > now
          ? conversation.botPausedUntil.toISOString()
          : null,
      counts: {
        upcoming,
        attended: count("COMPLETED"),
        noShow: count("NO_SHOW"),
        cancelled: count("CANCELLED"),
      },
      appointments: appointments.map((a) => ({
        id: a.id,
        startsAt: a.startsAt.toISOString(),
        status: a.status,
        procedure: a.procedure.name,
        dentist: a.dentist.name,
        authorization: a.authorization?.status ?? null,
        surveyRating: a.survey?.rating ?? null,
        aftercareAnswer: a.aftercare?.answer ?? null,
      })),
      quotes: quotes.map((q) => ({
        id: q.id,
        status: q.status,
        totalCents: q.totalCents,
        createdAt: q.createdAt.toISOString(),
        installments: q.installments.length,
        paidCents: sum(q.installments.filter((i) => i.status === "PAID")),
        openCents: sum(q.installments.filter((i) => isOpen(i.status))),
        overdue: q.installments.filter(isOverdue).length,
      })),
      balance: {
        openCents: sum(allInstallments.filter((i) => isOpen(i.status))),
        overdueCents: sum(allInstallments.filter(isOverdue)),
      },
      clinicPayments: payments.map((c) => ({
        id: c.id,
        paidAt: c.paidAt.toISOString(),
        amountCents: c.amountCents,
        method: c.method,
        procedure: c.procedure?.name ?? null,
      })),
      waitlist: waitlist.map((w) => ({
        id: w.id,
        procedure: w.procedure.name,
        until: w.until.toISOString(),
      })),
    };
  }
}
