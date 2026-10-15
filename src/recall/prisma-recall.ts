import type { AppointmentStatus, PrismaClient } from "@prisma/client";
import type { FieldCipher } from "../privacy/index.js";
import {
  RECALL_CONSENT_VERSION,
  RECALL_CONSENT_VERSION_WHATSAPP,
  type ConsentSource,
  type RecallRepository,
  type RecallRow,
} from "./recall.js";

/** The patient came (or the appointment was never marked otherwise). */
const VISITED: AppointmentStatus[] = ["PENDING_CONFIRMATION", "CONFIRMED", "COMPLETED"];
const ACTIVE: AppointmentStatus[] = ["PENDING_CONFIRMATION", "CONFIRMED"];

export class PrismaRecallRepository implements RecallRepository {
  constructor(
    private readonly db: PrismaClient,
    private readonly cipher: FieldCipher,
  ) {}

  async clinics() {
    const rows = await this.db.clinic.findMany({
      select: { id: true, name: true, timezone: true },
    });
    return rows.map((c) => ({ id: c.id, name: c.name, timeZone: c.timezone }));
  }

  async clinic(clinicId: string) {
    const c = await this.db.clinic.findUnique({
      where: { id: clinicId },
      select: { id: true, name: true, timezone: true },
    });
    return c ? { id: c.id, name: c.name, timeZone: c.timezone } : null;
  }

  async rows(clinicId: string, visitedBefore: Date, now: Date): Promise<RecallRow[]> {
    const patients = await this.db.patient.findMany({
      where: {
        clinicId,
        anonymizedAt: null,
        appointments: {
          some: { status: { in: VISITED }, startsAt: { lt: visitedBefore } },
          none: { status: { in: ACTIVE }, startsAt: { gte: now } },
        },
      },
      orderBy: { name: "asc" },
      take: 500,
      select: {
        id: true,
        name: true,
        phoneHash: true,
        phoneEncrypted: true,
        recallInvitedAt: true,
        appointments: {
          where: { status: { in: VISITED }, startsAt: { lt: now } },
          orderBy: { startsAt: "desc" },
          take: 1,
          select: { startsAt: true, procedure: { select: { name: true } } },
        },
        consents: {
          where: { purpose: "MARKETING" },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { granted: true, createdAt: true, source: true },
        },
      },
    });
    const last = patients.filter((p) => p.appointments[0]!.startsAt < visitedBefore);
    // Opt-outs live on the conversation, found by the same phone hash.
    const conversations = await this.db.conversation.findMany({
      where: { clinicId, contactHash: { in: last.map((p) => p.phoneHash) } },
      select: { contactHash: true, marketingOptOutAt: true },
    });
    const optOut = new Map(conversations.map((c) => [c.contactHash, c.marketingOptOutAt]));
    return last.map((p) => {
      const visit = p.appointments[0]!;
      const consent = p.consents[0];
      return {
        patientId: p.id,
        patientName: p.name,
        phone: this.cipher.decrypt(p.phoneEncrypted),
        lastVisitAt: visit.startsAt,
        lastProcedure: visit.procedure.name,
        consent: consent
          ? { granted: consent.granted, at: consent.createdAt, source: consent.source }
          : null,
        optedOutAt: optOut.get(p.phoneHash) ?? null,
        invitedAt: p.recallInvitedAt,
      };
    });
  }

  async claim(patientId: string, lastVisitAt: Date, at: Date) {
    const { count } = await this.db.patient.updateMany({
      where: {
        id: patientId,
        anonymizedAt: null,
        OR: [{ recallInvitedAt: null }, { recallInvitedAt: { lt: lastVisitAt } }],
      },
      data: { recallInvitedAt: at },
    });
    return count === 1;
  }

  async release(patientId: string, previous: Date | null) {
    await this.db.patient.updateMany({
      where: { id: patientId },
      data: { recallInvitedAt: previous },
    });
  }

  async consentOf(clinicId: string, patientId: string) {
    const c = await this.db.consent.findFirst({
      where: { patientId, purpose: "MARKETING", patient: { clinicId } },
      orderBy: { createdAt: "desc" },
      select: { granted: true, createdAt: true, source: true },
    });
    return c ? { granted: c.granted, at: c.createdAt, source: c.source } : null;
  }

  async recordConsent(
    clinicId: string,
    patientId: string,
    granted: boolean,
    at: Date,
    source: ConsentSource = "STAFF",
  ) {
    const patient = await this.db.patient.findFirst({
      where: { id: patientId, clinicId, anonymizedAt: null },
      select: { id: true },
    });
    if (!patient) return false;
    await this.db.consent.create({
      data: {
        patientId,
        purpose: "MARKETING",
        granted,
        textVersion:
          source === "WHATSAPP" ? RECALL_CONSENT_VERSION_WHATSAPP : RECALL_CONSENT_VERSION,
        source,
        createdAt: at,
      },
    });
    return true;
  }
}
