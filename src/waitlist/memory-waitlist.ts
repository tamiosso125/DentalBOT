import { randomUUID } from "node:crypto";
import type { InMemoryAgendaRepository } from "../scheduling/memory-agenda.js";
import type {
  ListedEntry,
  WaitingEntry,
  WaitlistAnswer,
  WaitlistRepository,
  WaitlistStatus,
} from "./waitlist.js";

type StoredEntry = {
  id: string;
  patientId: string;
  procedureId: string;
  until: Date;
  status: WaitlistStatus;
  appointmentId: string | null;
  createdAt: Date;
  closedAt: Date | null;
};

type StoredOffer = {
  id: string;
  entryId: string;
  dentistId: string;
  startsAt: Date;
  endsAt: Date;
  sentAt: Date;
  answer: WaitlistAnswer | null;
};

/** Waiting list over the in-memory agenda (tests and the conversation eval). */
export class InMemoryWaitlistRepository implements WaitlistRepository {
  readonly entries: StoredEntry[] = [];
  readonly offers: StoredOffer[] = [];

  constructor(
    private readonly agenda: InMemoryAgendaRepository,
    private readonly clinicName: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private get info() {
    return { id: this.agenda.clinicId, name: this.clinicName, timeZone: this.agenda.timeZone };
  }

  async clinicsWaiting() {
    return this.entries.some((e) => e.status === "WAITING") ? [this.info] : [];
  }

  async clinic(clinicId: string) {
    return clinicId === this.agenda.clinicId ? this.info : null;
  }

  async expire(clinicId: string, now: Date) {
    if (clinicId !== this.agenda.clinicId) return 0;
    let n = 0;
    for (const e of this.entries)
      if (e.status === "WAITING" && e.until <= now) {
        Object.assign(e, { status: "EXPIRED", closedAt: now });
        n++;
      }
    return n;
  }

  async waiting(clinicId: string): Promise<WaitingEntry[]> {
    if (clinicId !== this.agenda.clinicId) return [];
    return (await this.list(clinicId, new Date(8.64e15))).filter((e) => e.status === "WAITING");
  }

  async list(clinicId: string, closedSince: Date): Promise<ListedEntry[]> {
    if (clinicId !== this.agenda.clinicId) return [];
    const procedures = await this.agenda.procedures();
    return this.entries
      .filter((e) => e.status === "WAITING" || (e.closedAt && e.closedAt >= closedSince))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .flatMap((e) => {
        const patient = this.agenda.patients.find((p) => p.id === e.patientId);
        if (!patient) return [];
        const offers = this.offers.filter((o) => o.entryId === e.id);
        const last = offers.at(-1);
        return [
          {
            id: e.id,
            patientId: e.patientId,
            patientName: patient.name,
            phone: patient.phone,
            procedureId: e.procedureId,
            procedureName: procedures.find((p) => p.id === e.procedureId)?.name ?? "",
            until: e.until,
            createdAt: e.createdAt,
            lastOfferAt: last?.sentAt ?? null,
            status: e.status,
            closedAt: e.closedAt,
            offers: offers.length,
            lastOffer: last ? { startsAt: last.startsAt, answer: last.answer } : null,
          },
        ];
      });
  }

  async slotOfferedSince(dentistId: string, startsAt: Date, since: Date) {
    return this.offers.some(
      (o) =>
        o.dentistId === dentistId &&
        o.startsAt.getTime() === startsAt.getTime() &&
        o.sentAt >= since,
    );
  }

  async createOffer(
    entryId: string,
    slot: { dentistId: string; startsAt: Date; endsAt: Date },
    at: Date,
  ) {
    const dup = this.offers.some(
      (o) =>
        o.entryId === entryId &&
        o.dentistId === slot.dentistId &&
        o.startsAt.getTime() === slot.startsAt.getTime(),
    );
    if (dup) return null;
    const id = `offer_${randomUUID()}`;
    this.offers.push({
      id,
      entryId,
      dentistId: slot.dentistId,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      sentAt: at,
      answer: null,
    });
    return id;
  }

  async deleteOffer(offerId: string) {
    const i = this.offers.findIndex((o) => o.id === offerId);
    if (i >= 0) this.offers.splice(i, 1);
  }

  async offer(clinicId: string, offerId: string) {
    if (clinicId !== this.agenda.clinicId) return null;
    const o = this.offers.find((x) => x.id === offerId);
    const e = o && this.entries.find((x) => x.id === o.entryId);
    const patient = e && this.agenda.patients.find((p) => p.id === e.patientId);
    if (!o || !e || !patient) return null;
    const procedures = await this.agenda.procedures();
    return {
      id: o.id,
      entryId: e.id,
      entryStatus: e.status,
      patientId: e.patientId,
      phone: patient.phone,
      procedureId: e.procedureId,
      procedureName: procedures.find((p) => p.id === e.procedureId)?.name ?? "",
      dentistId: o.dentistId,
      startsAt: o.startsAt,
      endsAt: o.endsAt,
      answer: o.answer,
    };
  }

  async setAnswer(offerId: string, answer: WaitlistAnswer) {
    const o = this.offers.find((x) => x.id === offerId);
    if (o) o.answer = answer;
  }

  async close(
    clinicId: string,
    entryId: string,
    status: Exclude<WaitlistStatus, "WAITING">,
    at: Date,
  ) {
    const e = this.entries.find((x) => x.id === entryId);
    if (clinicId !== this.agenda.clinicId || e?.status !== "WAITING") return false;
    Object.assign(e, { status, closedAt: at });
    return true;
  }

  async settle(entryId: string, status: WaitlistStatus, at: Date, appointmentId?: string) {
    const e = this.entries.find((x) => x.id === entryId);
    if (!e) return;
    Object.assign(e, {
      status,
      closedAt: status === "WAITING" ? null : at,
      ...(appointmentId ? { appointmentId } : {}),
    });
  }

  async add(clinicId: string, patientId: string, procedureId: string, until: Date) {
    if (clinicId !== this.agenda.clinicId) return null;
    if (!this.agenda.patients.some((p) => p.id === patientId)) return null;
    if (!(await this.agenda.procedures()).some((p) => p.id === procedureId)) return null;
    const existing = this.entries.find(
      (e) => e.patientId === patientId && e.procedureId === procedureId && e.status === "WAITING",
    );
    if (existing) return { id: existing.id, created: false };
    const id = `wait_${randomUUID()}`;
    this.entries.push({
      id,
      patientId,
      procedureId,
      until,
      status: "WAITING",
      appointmentId: null,
      createdAt: this.now(),
      closedAt: null,
    });
    return { id, created: true };
  }
}
