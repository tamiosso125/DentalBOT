import { Prisma, type PrismaClient } from "@prisma/client";
import type { FieldCipher } from "../privacy/index.js";
import type {
  AftercareAnswer,
  AftercareRepository,
  CheckInCandidate,
  InstructionCandidate,
} from "./aftercare.js";

export class PrismaAftercareRepository implements AftercareRepository {
  constructor(
    private readonly db: PrismaClient,
    private readonly cipher: FieldCipher,
  ) {}

  async instructionCandidates(
    from: Date,
    to: Date,
    clinicId?: string,
  ): Promise<InstructionCandidate[]> {
    const rows = await this.db.appointment.findMany({
      where: {
        ...(clinicId ? { clinicId } : {}),
        status: "COMPLETED",
        startsAt: { gte: from, lt: to },
        aftercare: null,
        procedure: { aftercareText: { not: null } },
        patient: { anonymizedAt: null },
      },
      orderBy: { startsAt: "asc" },
      take: 500,
      select: {
        id: true,
        clinicId: true,
        startsAt: true,
        patientId: true,
        clinic: { select: { name: true, timezone: true } },
        patient: { select: { name: true, phoneEncrypted: true } },
        procedure: { select: { name: true, aftercareText: true } },
      },
    });
    return rows.map((a) => ({
      appointmentId: a.id,
      clinicId: a.clinicId,
      clinicName: a.clinic.name,
      clinicTimeZone: a.clinic.timezone,
      patientId: a.patientId,
      patientName: a.patient.name,
      phone: this.cipher.decrypt(a.patient.phoneEncrypted),
      startsAt: a.startsAt,
      procedureName: a.procedure.name,
      aftercareText: a.procedure.aftercareText ?? "",
    }));
  }

  async create(c: InstructionCandidate, at: Date) {
    try {
      const f = await this.db.aftercareFollowUp.create({
        data: {
          clinicId: c.clinicId,
          appointmentId: c.appointmentId,
          patientId: c.patientId,
          instructionsSentAt: at,
        },
        select: { id: true },
      });
      return f.id;
    } catch (err) {
      // Unique appointment: another run already sent the instructions.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return null;
      throw err;
    }
  }

  async remove(followUpId: string) {
    await this.db.aftercareFollowUp.deleteMany({ where: { id: followUpId, checkInSentAt: null } });
  }

  async checkInCandidates(from: Date, to: Date, clinicId?: string): Promise<CheckInCandidate[]> {
    const rows = await this.db.aftercareFollowUp.findMany({
      where: {
        ...(clinicId ? { clinicId } : {}),
        checkInSentAt: null,
        instructionsSentAt: { gte: from, lt: to },
        patient: { anonymizedAt: null },
      },
      orderBy: { instructionsSentAt: "asc" },
      take: 500,
      select: {
        id: true,
        clinicId: true,
        instructionsSentAt: true,
        clinic: { select: { name: true, timezone: true } },
        patient: { select: { name: true, phoneEncrypted: true } },
        appointment: { select: { procedure: { select: { name: true } } } },
      },
    });
    return rows.map((f) => ({
      followUpId: f.id,
      clinicId: f.clinicId,
      clinicName: f.clinic.name,
      clinicTimeZone: f.clinic.timezone,
      patientName: f.patient.name,
      phone: this.cipher.decrypt(f.patient.phoneEncrypted),
      procedureName: f.appointment.procedure.name,
      instructionsSentAt: f.instructionsSentAt,
    }));
  }

  async claimCheckIn(followUpId: string, at: Date) {
    const { count } = await this.db.aftercareFollowUp.updateMany({
      where: { id: followUpId, checkInSentAt: null },
      data: { checkInSentAt: at },
    });
    return count === 1;
  }

  async releaseCheckIn(followUpId: string) {
    await this.db.aftercareFollowUp.updateMany({
      where: { id: followUpId, answer: null },
      data: { checkInSentAt: null },
    });
  }

  async get(clinicId: string, followUpId: string) {
    const f = await this.db.aftercareFollowUp.findFirst({
      where: { id: followUpId, clinicId },
      select: {
        id: true,
        checkInSentAt: true,
        answer: true,
        patient: { select: { phoneEncrypted: true } },
      },
    });
    return f
      ? {
          id: f.id,
          phone: this.cipher.decrypt(f.patient.phoneEncrypted),
          checkInSentAt: f.checkInSentAt,
          answer: f.answer,
        }
      : null;
  }

  async recordAnswer(followUpId: string, answer: AftercareAnswer, at: Date) {
    await this.db.aftercareFollowUp.update({
      where: { id: followUpId },
      data: { answer, answeredAt: at },
    });
  }

  async clinicTimeZone(clinicId: string) {
    const c = await this.db.clinic.findUnique({
      where: { id: clinicId },
      select: { timezone: true },
    });
    return c?.timezone ?? null;
  }

  async sentBetween(clinicId: string, from: Date, to: Date) {
    const rows = await this.db.aftercareFollowUp.findMany({
      where: { clinicId, instructionsSentAt: { gte: from, lt: to } },
      select: { checkInSentAt: true, answer: true },
    });
    return rows.map((r) => ({ checkIn: r.checkInSentAt !== null, answer: r.answer }));
  }

  async helpRequests(clinicId: string, since: Date) {
    const rows = await this.db.aftercareFollowUp.findMany({
      where: { clinicId, answer: "HELP", answeredAt: { gte: since } },
      orderBy: { answeredAt: "desc" },
      take: 50,
      select: {
        id: true,
        patientId: true,
        answeredAt: true,
        appointment: { select: { startsAt: true, procedure: { select: { name: true } } } },
        patient: { select: { name: true, phoneEncrypted: true } },
      },
    });
    return rows.map((f) => ({
      followUpId: f.id,
      patientId: f.patientId,
      patientName: f.patient.name,
      phone: this.cipher.decrypt(f.patient.phoneEncrypted),
      procedureName: f.appointment.procedure.name,
      appointmentAt: f.appointment.startsAt,
      answeredAt: f.answeredAt!,
    }));
  }
}
