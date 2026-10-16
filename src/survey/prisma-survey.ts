import { Prisma, type PrismaClient } from "@prisma/client";
import type { FieldCipher } from "../privacy/index.js";
import type { SurveyCandidate, SurveyRepository } from "./survey.js";

export class PrismaSurveyRepository implements SurveyRepository {
  constructor(
    private readonly db: PrismaClient,
    private readonly cipher: FieldCipher,
  ) {}

  async candidates(from: Date, to: Date, clinicId?: string): Promise<SurveyCandidate[]> {
    const rows = await this.db.appointment.findMany({
      where: {
        ...(clinicId ? { clinicId } : {}),
        status: "COMPLETED",
        startsAt: { gte: from, lt: to },
        survey: null,
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
    }));
  }

  async askedSince(patientId: string, since: Date) {
    const n = await this.db.satisfactionSurvey.count({
      where: { patientId, sentAt: { gte: since } },
    });
    return n > 0;
  }

  async create(c: SurveyCandidate, at: Date) {
    try {
      const s = await this.db.satisfactionSurvey.create({
        data: {
          clinicId: c.clinicId,
          appointmentId: c.appointmentId,
          patientId: c.patientId,
          sentAt: at,
        },
        select: { id: true },
      });
      return s.id;
    } catch (err) {
      // Unique appointment: another run already asked about it.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return null;
      throw err;
    }
  }

  async remove(surveyId: string) {
    await this.db.satisfactionSurvey.deleteMany({ where: { id: surveyId, rating: null } });
  }

  async get(clinicId: string, surveyId: string) {
    const s = await this.db.satisfactionSurvey.findFirst({
      where: { id: surveyId, clinicId },
      select: {
        id: true,
        patientId: true,
        rating: true,
        patient: { select: { phoneEncrypted: true } },
      },
    });
    return s
      ? {
          id: s.id,
          patientId: s.patientId,
          rating: s.rating,
          phone: this.cipher.decrypt(s.patient.phoneEncrypted),
        }
      : null;
  }

  async answer(surveyId: string, rating: number, at: Date) {
    const { count } = await this.db.satisfactionSurvey.updateMany({
      where: { id: surveyId, rating: null },
      data: { rating, answeredAt: at },
    });
    return count === 1;
  }

  async clinicTimeZone(clinicId: string) {
    const c = await this.db.clinic.findUnique({
      where: { id: clinicId },
      select: { timezone: true },
    });
    return c?.timezone ?? null;
  }

  async sentBetween(clinicId: string, from: Date, to: Date) {
    const rows = await this.db.satisfactionSurvey.findMany({
      where: { clinicId, sentAt: { gte: from, lt: to } },
      select: { rating: true },
    });
    return {
      sent: rows.length,
      ratings: rows.flatMap((r) => (r.rating === null ? [] : [r.rating])),
    };
  }

  async lowRatings(clinicId: string, since: Date, max: number) {
    const rows = await this.db.satisfactionSurvey.findMany({
      where: { clinicId, rating: { lte: max }, answeredAt: { gte: since } },
      orderBy: { answeredAt: "desc" },
      take: 50,
      select: {
        id: true,
        patientId: true,
        rating: true,
        answeredAt: true,
        appointment: { select: { startsAt: true } },
        patient: { select: { name: true, phoneEncrypted: true } },
      },
    });
    return rows.map((s) => ({
      surveyId: s.id,
      patientId: s.patientId,
      patientName: s.patient.name,
      phone: this.cipher.decrypt(s.patient.phoneEncrypted),
      rating: s.rating!,
      answeredAt: s.answeredAt!,
      appointmentAt: s.appointment.startsAt,
    }));
  }
}
