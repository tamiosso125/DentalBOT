import type { InMemoryConversationStore } from "../conversation/store.js";
import type { InMemoryAgendaRepository } from "../scheduling/memory-agenda.js";
import type { ConsentSource, RecallRepository, RecallRow } from "./recall.js";

/** Recall over the in-memory agenda and conversations (tests and the conversation eval). */
export class InMemoryRecallRepository implements RecallRepository {
  readonly consents: Array<{
    patientId: string;
    granted: boolean;
    at: Date;
    source: ConsentSource;
  }> = [];
  readonly invited = new Map<string, Date>();

  constructor(
    private readonly agenda: InMemoryAgendaRepository,
    private readonly store: InMemoryConversationStore,
    private readonly clinicName: string,
  ) {}

  async clinics() {
    return [{ id: this.agenda.clinicId, name: this.clinicName, timeZone: this.agenda.timeZone }];
  }

  async clinic(clinicId: string) {
    return clinicId === this.agenda.clinicId ? (await this.clinics())[0]! : null;
  }

  async rows(clinicId: string, visitedBefore: Date, now: Date): Promise<RecallRow[]> {
    if (clinicId !== this.agenda.clinicId) return [];
    const procedures = await this.agenda.procedures();
    return this.agenda.patients.flatMap((p) => {
      const mine = this.agenda.appointments.filter((a) => a.patientId === p.id);
      const upcoming = mine.some(
        (a) =>
          (a.status === "PENDING_CONFIRMATION" || a.status === "CONFIRMED") && a.startsAt >= now,
      );
      const last = mine
        .filter((a) => a.status !== "CANCELLED" && a.status !== "NO_SHOW" && a.startsAt < now)
        .sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime())[0];
      if (upcoming || !last || last.startsAt >= visitedBefore) return [];
      const consent = this.consents.filter((c) => c.patientId === p.id).at(-1);
      const conv = [...this.store.conversations.values()].find((c) => c.contact === p.phone);
      return [
        {
          patientId: p.id,
          patientName: p.name,
          phone: p.phone,
          lastVisitAt: last.startsAt,
          lastProcedure: procedures.find((x) => x.id === last.procedureId)?.name ?? "",
          consent: consent
            ? { granted: consent.granted, at: consent.at, source: consent.source }
            : null,
          optedOutAt: conv?.marketingOptOutAt ?? null,
          invitedAt: this.invited.get(p.id) ?? null,
        },
      ];
    });
  }

  async claim(patientId: string, lastVisitAt: Date, at: Date) {
    const prev = this.invited.get(patientId);
    if (prev && prev >= lastVisitAt) return false;
    this.invited.set(patientId, at);
    return true;
  }

  async release(patientId: string, previous: Date | null) {
    if (previous) this.invited.set(patientId, previous);
    else this.invited.delete(patientId);
  }

  async recordConsent(
    clinicId: string,
    patientId: string,
    granted: boolean,
    at: Date,
    source: ConsentSource = "STAFF",
  ) {
    if (clinicId !== this.agenda.clinicId || !this.agenda.patients.some((p) => p.id === patientId))
      return false;
    this.consents.push({ patientId, granted, at, source });
    return true;
  }

  async consentOf(clinicId: string, patientId: string) {
    if (clinicId !== this.agenda.clinicId) return null;
    const c = this.consents.filter((x) => x.patientId === patientId).at(-1);
    return c ? { granted: c.granted, at: c.at, source: c.source } : null;
  }
}
