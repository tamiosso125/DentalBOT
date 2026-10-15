import { Prisma, type PrismaClient } from "@prisma/client";
import { maskPhone, type FieldCipher } from "../privacy/index.js";

/**
 * LGPD data subject rights (art. 18) for the staff panel: list the "MEUS DADOS" requests,
 * hand the patient a copy of their data, and anonymize them on request.
 *
 * Anonymizing wipes the personal fields and message bodies but keeps the financial records
 * (quotes, installments) that the clinic must retain by law, now tied to no one. It is
 * refused while an installment is still open: the debt is a legal basis to keep the data.
 */

export type DataRequestRow = {
  id: string;
  createdAt: string;
  patientId: string | null;
  patientName: string | null;
  /** Last 4 digits only. */
  contact: string;
};

export type PatientSummary = {
  id: string;
  name: string;
  /** Last 4 digits only. */
  phone: string;
  createdAt: string;
  anonymizedAt: string | null;
  appointments: number;
  quotes: number;
  /** Installments still to be paid (pending, billed or overdue). */
  openInstallments: number;
};

export type PatientExport = {
  generatedAt: string;
  clinic: string;
  patient: {
    name: string;
    phone: string;
    cpf: string | null;
    birthDate: string | null;
    insurancePlan: string | null;
    insuranceCard: string | null;
    createdAt: string;
  } | null;
  consents: Array<{
    purpose: string;
    granted: boolean;
    textVersion: string;
    source: string;
    at: string;
  }>;
  appointments: Array<{
    startsAt: string;
    endsAt: string;
    status: string;
    procedure: string;
    dentist: string;
  }>;
  quotes: Array<{
    status: string;
    totalCents: number;
    installmentCount: number;
    notes: string | null;
    validUntil: string | null;
    createdAt: string;
    items: Array<{
      description: string;
      quantity: number;
      unitPriceCents: number;
      coverage: string;
    }>;
    installments: Array<{
      number: number;
      amountCents: number;
      dueDate: string;
      status: string;
      paidAt: string | null;
    }>;
  }>;
  conversations: Array<{
    contact: string;
    createdAt: string;
    privacyNoticeAt: string | null;
    marketingOptOutAt: string | null;
    messages: Array<{ at: string; direction: string; type: string; body: string | null }>;
  }>;
};

export type AnonymizeResult = {
  cancelledAppointments: number;
  conversations: number;
  messages: number;
};

/** Who a request is about: a registered patient, or a request made through a conversation. */
export type SubjectRef = { patientId: string } | { requestId: string };

/** A request the front desk can act on. `status` is the HTTP code. */
export class PatientDataError extends Error {
  constructor(
    readonly status: 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "PatientDataError";
  }
}

export interface PatientData {
  dataRequests(clinicId: string): Promise<DataRequestRow[]>;
  resolveRequest(clinicId: string, requestId: string, now: Date): Promise<void>;
  summary(clinicId: string, patientId: string): Promise<PatientSummary | null>;
  export(clinicId: string, ref: SubjectRef, now: Date): Promise<PatientExport>;
  /** Also closes the request when `ref` is one. */
  anonymize(clinicId: string, ref: SubjectRef, now: Date): Promise<AnonymizeResult>;
}

const OPEN_INSTALLMENT = { in: ["PENDING" as const, "BILLED" as const, "OVERDUE" as const] };
const ANONYMIZED_NAME = "Paciente anonimizado";

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const dateOnly = (d: Date) => d.toISOString().slice(0, 10);

type Subject = {
  patient: { id: string; phoneHash: string } | null;
  requestId: string | null;
  /** Conversations of this person: the patient's, plus the one the request came from. */
  conversationIds: string[];
};

export class PrismaPatientData implements PatientData {
  constructor(
    private readonly db: PrismaClient,
    private readonly cipher: FieldCipher,
  ) {}

  async dataRequests(clinicId: string) {
    const rows = await this.db.dataSubjectRequest.findMany({
      where: { clinicId, status: "OPEN" },
      orderBy: { createdAt: "asc" },
      take: 100,
    });
    const conversations = await this.db.conversation.findMany({
      where: { clinicId, id: { in: rows.map((r) => r.conversationId) } },
      select: {
        id: true,
        contactHash: true,
        contactEncrypted: true,
        patient: { select: { id: true, name: true } },
      },
    });
    // Conversations no booking linked yet still find the patient by number.
    const byPhone = new Map(
      (
        await this.db.patient.findMany({
          where: {
            clinicId,
            phoneHash: { in: conversations.filter((c) => !c.patient).map((c) => c.contactHash) },
          },
          select: { id: true, name: true, phoneHash: true },
        })
      ).map((p) => [p.phoneHash, p]),
    );
    const byId = new Map(conversations.map((c) => [c.id, c]));
    return rows.map((r) => {
      const c = byId.get(r.conversationId);
      const patient = c ? (c.patient ?? byPhone.get(c.contactHash) ?? null) : null;
      return {
        id: r.id,
        createdAt: r.createdAt.toISOString(),
        patientId: patient?.id ?? null,
        patientName: patient?.name ?? null,
        contact: c ? maskPhone(this.cipher.decrypt(c.contactEncrypted)) : "****",
      };
    });
  }

  async resolveRequest(clinicId: string, requestId: string, now: Date) {
    const { count } = await this.db.dataSubjectRequest.updateMany({
      where: { id: requestId, clinicId, status: "OPEN" },
      data: { status: "DONE", resolvedAt: now },
    });
    if (count === 0) throw new PatientDataError(404, "Pedido não encontrado.");
  }

  async summary(clinicId: string, patientId: string) {
    const p = await this.db.patient.findFirst({
      where: { id: patientId, clinicId },
      select: {
        id: true,
        name: true,
        phoneEncrypted: true,
        createdAt: true,
        anonymizedAt: true,
        _count: { select: { appointments: true, quotes: true } },
      },
    });
    if (!p) return null;
    const openInstallments = await this.db.installment.count({
      where: { status: OPEN_INSTALLMENT, quote: { patientId, clinicId } },
    });
    return {
      id: p.id,
      name: p.name,
      phone: maskPhone(this.cipher.decrypt(p.phoneEncrypted)),
      createdAt: p.createdAt.toISOString(),
      anonymizedAt: iso(p.anonymizedAt),
      appointments: p._count.appointments,
      quotes: p._count.quotes,
      openInstallments,
    };
  }

  async export(clinicId: string, ref: SubjectRef, now: Date): Promise<PatientExport> {
    const subject = await this.subject(clinicId, ref);
    const clinic = await this.db.clinic.findUniqueOrThrow({
      where: { id: clinicId },
      select: { name: true },
    });
    const patientId = subject.patient?.id;
    const patient = patientId
      ? await this.db.patient.findUniqueOrThrow({
          where: { id: patientId },
          include: {
            insurancePlan: { select: { name: true } },
            consents: { orderBy: { createdAt: "asc" } },
            appointments: {
              orderBy: { startsAt: "asc" },
              include: {
                procedure: { select: { name: true } },
                dentist: { select: { name: true } },
              },
            },
            quotes: {
              orderBy: { createdAt: "asc" },
              include: { items: true, installments: { orderBy: { number: "asc" } } },
            },
          },
        })
      : null;
    const conversations = await this.db.conversation.findMany({
      where: { id: { in: subject.conversationIds } },
      orderBy: { createdAt: "asc" },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });
    const open = (v: string | null) => (v ? this.cipher.decrypt(v) : null);

    return {
      generatedAt: now.toISOString(),
      clinic: clinic.name,
      patient: patient
        ? {
            name: patient.name,
            phone: this.cipher.decrypt(patient.phoneEncrypted),
            cpf: open(patient.cpfEncrypted),
            birthDate: patient.birthDate ? dateOnly(patient.birthDate) : null,
            insurancePlan: patient.insurancePlan?.name ?? null,
            insuranceCard: open(patient.insuranceCardEncrypted),
            createdAt: patient.createdAt.toISOString(),
          }
        : null,
      consents: (patient?.consents ?? []).map((c) => ({
        purpose: c.purpose,
        granted: c.granted,
        textVersion: c.textVersion,
        source: c.source,
        at: c.createdAt.toISOString(),
      })),
      appointments: (patient?.appointments ?? []).map((a) => ({
        startsAt: a.startsAt.toISOString(),
        endsAt: a.endsAt.toISOString(),
        status: a.status,
        procedure: a.procedure.name,
        dentist: a.dentist.name,
      })),
      quotes: (patient?.quotes ?? []).map((q) => ({
        status: q.status,
        totalCents: q.totalCents,
        installmentCount: q.installmentCount,
        notes: q.notes,
        validUntil: q.validUntil ? dateOnly(q.validUntil) : null,
        createdAt: q.createdAt.toISOString(),
        items: q.items.map((i) => ({
          description: i.description,
          quantity: i.quantity,
          unitPriceCents: i.unitPriceCents,
          coverage: i.coverage,
        })),
        installments: q.installments.map((i) => ({
          number: i.number,
          amountCents: i.amountCents,
          dueDate: dateOnly(i.dueDate),
          status: i.status,
          paidAt: iso(i.paidAt),
        })),
      })),
      conversations: conversations.map((c) => ({
        contact: this.cipher.decrypt(c.contactEncrypted),
        createdAt: c.createdAt.toISOString(),
        privacyNoticeAt: iso(c.privacyNoticeAt),
        marketingOptOutAt: iso(c.marketingOptOutAt),
        messages: c.messages.map((m) => ({
          at: m.createdAt.toISOString(),
          direction: m.direction,
          type: m.type,
          body: open(m.bodyEncrypted),
        })),
      })),
    };
  }

  async anonymize(clinicId: string, ref: SubjectRef, now: Date): Promise<AnonymizeResult> {
    const subject = await this.subject(clinicId, ref);
    const patientId = subject.patient?.id;
    if (patientId) {
      const open = await this.db.installment.count({
        where: { status: OPEN_INSTALLMENT, quote: { patientId } },
      });
      if (open > 0)
        throw new PatientDataError(
          409,
          `Há ${open} parcela(s) em aberto. Os dados ficam guardados até a quitação ou o cancelamento da cobrança.`,
        );
    }
    // Hash of a value no phone can have, so the real number is free to register again.
    const blank = this.cipher.encrypt("");

    return this.db.$transaction(async (tx: Prisma.TransactionClient) => {
      let cancelledAppointments = 0;
      if (patientId) {
        ({ count: cancelledAppointments } = await tx.appointment.updateMany({
          where: {
            patientId,
            status: { in: ["PENDING_CONFIRMATION", "CONFIRMED"] },
            startsAt: { gt: now },
          },
          data: { status: "CANCELLED" },
        }));
        await tx.patient.update({
          where: { id: patientId },
          data: {
            name: ANONYMIZED_NAME,
            phoneHash: this.cipher.hash(`anon:${patientId}`),
            phoneEncrypted: blank,
            cpfHash: null,
            cpfEncrypted: null,
            birthDate: null,
            insurancePlanId: null,
            insuranceCardEncrypted: null,
            asaasCustomerId: null,
            anonymizedAt: now,
          },
        });
        // Free text from the dentist may describe the treatment.
        await tx.quote.updateMany({ where: { patientId }, data: { notes: null } });
      }
      const { count: messages } = await tx.message.updateMany({
        where: { conversationId: { in: subject.conversationIds }, bodyEncrypted: { not: null } },
        data: { bodyEncrypted: null },
      });
      for (const id of subject.conversationIds) {
        await tx.conversation.update({
          where: { id },
          data: {
            contactHash: this.cipher.hash(`anon:${id}`),
            contactEncrypted: blank,
            agentState: Prisma.DbNull,
            botPausedUntil: null,
          },
        });
      }
      if (subject.requestId)
        await tx.dataSubjectRequest.updateMany({
          where: { id: subject.requestId, status: "OPEN" },
          data: { status: "DONE", resolvedAt: now },
        });
      return { cancelledAppointments, conversations: subject.conversationIds.length, messages };
    });
  }

  private async subject(clinicId: string, ref: SubjectRef): Promise<Subject> {
    let patientId: string | null = null;
    let requestId: string | null = null;
    const conversationIds = new Set<string>();
    if ("requestId" in ref) {
      const r = await this.db.dataSubjectRequest.findFirst({
        where: { id: ref.requestId, clinicId },
      });
      const c = r
        ? await this.db.conversation.findFirst({
            where: { id: r.conversationId, clinicId },
            select: { id: true, patientId: true, contactHash: true },
          })
        : null;
      if (!r || !c) throw new PatientDataError(404, "Pedido não encontrado.");
      requestId = r.id;
      // Same hash scheme: a conversation not linked yet still finds the patient by number.
      patientId =
        c.patientId ??
        (
          await this.db.patient.findFirst({
            where: { clinicId, phoneHash: c.contactHash },
            select: { id: true },
          })
        )?.id ??
        null;
      conversationIds.add(c.id);
    } else {
      patientId = ref.patientId;
    }

    let patient: Subject["patient"] = null;
    if (patientId) {
      patient = await this.db.patient.findFirst({
        where: { id: patientId, clinicId },
        select: { id: true, phoneHash: true },
      });
      if (!patient) throw new PatientDataError(404, "Paciente não encontrado.");
      // The patient's number may have a conversation not linked to the record yet.
      const convs = await this.db.conversation.findMany({
        where: { clinicId, OR: [{ patientId }, { contactHash: patient.phoneHash }] },
        select: { id: true },
      });
      for (const c of convs) conversationIds.add(c.id);
    }
    return { patient, requestId, conversationIds: [...conversationIds] };
  }
}
