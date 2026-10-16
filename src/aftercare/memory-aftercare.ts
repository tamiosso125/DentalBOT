import { randomUUID } from "node:crypto";
import type { InMemoryAgendaRepository } from "../scheduling/memory-agenda.js";
import type {
  AftercareAnswer,
  AftercareRepository,
  CheckInCandidate,
  InstructionCandidate,
} from "./aftercare.js";

type StoredRow = {
  id: string;
  appointmentId: string;
  patientId: string;
  instructionsSentAt: Date;
  checkInSentAt: Date | null;
  answer: AftercareAnswer | null;
  answeredAt: Date | null;
};

/** Follow-ups over the in-memory agenda (tests and the conversation eval). */
export class InMemoryAftercareRepository implements AftercareRepository {
  readonly followUps: StoredRow[] = [];

  /** `texts`: care text per procedure id, as the dentist registers it in the panel. */
  constructor(
    private readonly agenda: InMemoryAgendaRepository,
    private readonly clinicName: string,
    readonly texts: Map<string, string> = new Map(),
  ) {}

  private procedureName(procedureId: string) {
    return this.agenda.procedureList.find((p) => p.id === procedureId)?.name ?? "";
  }

  async instructionCandidates(
    from: Date,
    to: Date,
    clinicId?: string,
  ): Promise<InstructionCandidate[]> {
    if (clinicId && clinicId !== this.agenda.clinicId) return [];
    return this.agenda.appointments
      .filter(
        (a) =>
          a.status === "COMPLETED" &&
          a.startsAt >= from &&
          a.startsAt < to &&
          this.texts.has(a.procedureId) &&
          !this.followUps.some((f) => f.appointmentId === a.id),
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
            procedureName: this.procedureName(a.procedureId),
            aftercareText: this.texts.get(a.procedureId) ?? "",
          },
        ];
      });
  }

  async create(c: InstructionCandidate, at: Date) {
    if (this.followUps.some((f) => f.appointmentId === c.appointmentId)) return null;
    const id = `care_${randomUUID()}`;
    this.followUps.push({
      id,
      appointmentId: c.appointmentId,
      patientId: c.patientId,
      instructionsSentAt: at,
      checkInSentAt: null,
      answer: null,
      answeredAt: null,
    });
    return id;
  }

  async remove(followUpId: string) {
    const i = this.followUps.findIndex((f) => f.id === followUpId && f.checkInSentAt === null);
    if (i >= 0) this.followUps.splice(i, 1);
  }

  async checkInCandidates(from: Date, to: Date, clinicId?: string): Promise<CheckInCandidate[]> {
    if (clinicId && clinicId !== this.agenda.clinicId) return [];
    return this.followUps
      .filter(
        (f) =>
          f.checkInSentAt === null && f.instructionsSentAt >= from && f.instructionsSentAt < to,
      )
      .flatMap((f) => {
        const p = this.agenda.patients.find((x) => x.id === f.patientId);
        const a = this.agenda.appointments.find((x) => x.id === f.appointmentId);
        if (!p || !a) return [];
        return [
          {
            followUpId: f.id,
            clinicId: this.agenda.clinicId,
            clinicName: this.clinicName,
            clinicTimeZone: this.agenda.timeZone,
            patientName: p.name,
            phone: p.phone,
            procedureName: this.procedureName(a.procedureId),
            instructionsSentAt: f.instructionsSentAt,
          },
        ];
      });
  }

  async claimCheckIn(followUpId: string, at: Date) {
    const f = this.followUps.find((x) => x.id === followUpId);
    if (!f || f.checkInSentAt !== null) return false;
    f.checkInSentAt = at;
    return true;
  }

  async releaseCheckIn(followUpId: string) {
    const f = this.followUps.find((x) => x.id === followUpId);
    if (f && f.answer === null) f.checkInSentAt = null;
  }

  async get(clinicId: string, followUpId: string) {
    if (clinicId !== this.agenda.clinicId) return null;
    const f = this.followUps.find((x) => x.id === followUpId);
    const p = f && this.agenda.patients.find((x) => x.id === f.patientId);
    return f && p
      ? { id: f.id, phone: p.phone, checkInSentAt: f.checkInSentAt, answer: f.answer }
      : null;
  }

  async recordAnswer(followUpId: string, answer: AftercareAnswer, at: Date) {
    const f = this.followUps.find((x) => x.id === followUpId);
    if (f) Object.assign(f, { answer, answeredAt: at });
  }

  async clinicTimeZone(clinicId: string) {
    return clinicId === this.agenda.clinicId ? this.agenda.timeZone : null;
  }

  async sentBetween(clinicId: string, from: Date, to: Date) {
    if (clinicId !== this.agenda.clinicId) return [];
    return this.followUps
      .filter((f) => f.instructionsSentAt >= from && f.instructionsSentAt < to)
      .map((f) => ({ checkIn: f.checkInSentAt !== null, answer: f.answer }));
  }

  async helpRequests(clinicId: string, since: Date) {
    if (clinicId !== this.agenda.clinicId) return [];
    return this.followUps
      .filter((f) => f.answer === "HELP" && f.answeredAt! >= since)
      .sort((a, b) => b.answeredAt!.getTime() - a.answeredAt!.getTime())
      .flatMap((f) => {
        const p = this.agenda.patients.find((x) => x.id === f.patientId);
        const a = this.agenda.appointments.find((x) => x.id === f.appointmentId);
        if (!p || !a) return [];
        return [
          {
            followUpId: f.id,
            patientId: f.patientId,
            patientName: p.name,
            phone: p.phone,
            procedureName: this.procedureName(a.procedureId),
            appointmentAt: a.startsAt,
            answeredAt: f.answeredAt!,
          },
        ];
      });
  }
}
