import { randomUUID } from "node:crypto";
import type { InMemoryAgendaRepository } from "../scheduling/memory-agenda.js";
import type { SurveyCandidate, SurveyRepository } from "./survey.js";

type StoredRow = {
  id: string;
  appointmentId: string;
  patientId: string;
  sentAt: Date;
  rating: number | null;
  answeredAt: Date | null;
};

/** Surveys over the in-memory agenda (tests and the conversation eval). */
export class InMemorySurveyRepository implements SurveyRepository {
  readonly surveys: StoredRow[] = [];

  constructor(
    private readonly agenda: InMemoryAgendaRepository,
    private readonly clinicName: string,
  ) {}

  async candidates(from: Date, to: Date, clinicId?: string): Promise<SurveyCandidate[]> {
    if (clinicId && clinicId !== this.agenda.clinicId) return [];
    return this.agenda.appointments
      .filter(
        (a) =>
          a.status === "COMPLETED" &&
          a.startsAt >= from &&
          a.startsAt < to &&
          !this.surveys.some((s) => s.appointmentId === a.id),
      )
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
      .flatMap((a) => {
        const p = this.agenda.patients.find((x) => x.id === a.patientId);
        if (!p) return [];
        return [
          {
            appointmentId: a.id,
            clinicId: this.agenda.clinicId,
            clinicName: this.clinicName,
            clinicTimeZone: this.agenda.timeZone,
            patientId: p.id,
            patientName: p.name,
            phone: p.phone,
            startsAt: a.startsAt,
          },
        ];
      });
  }

  async askedSince(patientId: string, since: Date) {
    return this.surveys.some((s) => s.patientId === patientId && s.sentAt >= since);
  }

  async create(c: SurveyCandidate, at: Date) {
    if (this.surveys.some((s) => s.appointmentId === c.appointmentId)) return null;
    const id = `survey_${randomUUID()}`;
    this.surveys.push({
      id,
      appointmentId: c.appointmentId,
      patientId: c.patientId,
      sentAt: at,
      rating: null,
      answeredAt: null,
    });
    return id;
  }

  async remove(surveyId: string) {
    const i = this.surveys.findIndex((s) => s.id === surveyId && s.rating === null);
    if (i >= 0) this.surveys.splice(i, 1);
  }

  async get(clinicId: string, surveyId: string) {
    if (clinicId !== this.agenda.clinicId) return null;
    const s = this.surveys.find((x) => x.id === surveyId);
    const p = s && this.agenda.patients.find((x) => x.id === s.patientId);
    return s && p ? { id: s.id, patientId: s.patientId, phone: p.phone, rating: s.rating } : null;
  }

  async answer(surveyId: string, rating: number, at: Date) {
    const s = this.surveys.find((x) => x.id === surveyId);
    if (!s || s.rating !== null) return false;
    Object.assign(s, { rating, answeredAt: at });
    return true;
  }

  async clinicTimeZone(clinicId: string) {
    return clinicId === this.agenda.clinicId ? this.agenda.timeZone : null;
  }

  async sentBetween(clinicId: string, from: Date, to: Date) {
    const rows =
      clinicId === this.agenda.clinicId
        ? this.surveys.filter((s) => s.sentAt >= from && s.sentAt < to)
        : [];
    return {
      sent: rows.length,
      ratings: rows.flatMap((s) => (s.rating === null ? [] : [s.rating])),
    };
  }

  async lowRatings(clinicId: string, since: Date, max: number) {
    if (clinicId !== this.agenda.clinicId) return [];
    return this.surveys
      .filter((s) => s.rating !== null && s.rating <= max && s.answeredAt! >= since)
      .sort((a, b) => b.answeredAt!.getTime() - a.answeredAt!.getTime())
      .flatMap((s) => {
        const p = this.agenda.patients.find((x) => x.id === s.patientId);
        const a = this.agenda.appointments.find((x) => x.id === s.appointmentId);
        if (!p || !a) return [];
        return [
          {
            surveyId: s.id,
            patientId: s.patientId,
            patientName: p.name,
            phone: p.phone,
            rating: s.rating!,
            answeredAt: s.answeredAt!,
            appointmentAt: a.startsAt,
          },
        ];
      });
  }
}
