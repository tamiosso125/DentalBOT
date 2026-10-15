import { randomUUID } from "node:crypto";
import type { AppointmentInfo, PatientRef, ProcedureInfo, Slot } from "./agenda-provider.js";
import type { AgendaRepository, DentistSchedule } from "./agenda-service.js";
import type { BusyInterval } from "./slots.js";

type StoredAppointment = Slot & {
  id: string;
  patientId: string;
  status: AppointmentInfo["status"];
  reminderSentAt: Date | null;
};

export type MemoryAgendaSeed = {
  clinicId: string;
  timeZone: string;
  procedures: ProcedureInfo[];
  dentists: DentistSchedule[];
  blocks?: Array<{ dentistId: string; startsAt: Date; endsAt: Date }>;
};

/** In-memory agenda for tests, the conversation eval and dev tools. Single-threaded, so atomic. */
export class InMemoryAgendaRepository implements AgendaRepository {
  readonly appointments: StoredAppointment[] = [];
  readonly patients: Array<PatientRef & { phone: string }> = [];

  constructor(private readonly seed: MemoryAgendaSeed) {}

  get clinicId() {
    return this.seed.clinicId;
  }

  get timeZone() {
    return this.seed.timeZone;
  }

  async procedures() {
    return this.seed.procedures;
  }

  async dentists() {
    return this.seed.dentists;
  }

  async busy(dentistId: string, from: Date, to: Date, ignoreAppointmentId?: string) {
    const out: BusyInterval[] = [];
    for (const a of this.active(dentistId, ignoreAppointmentId))
      if (a.startsAt < to && a.endsAt > from) out.push(a);
    for (const b of this.seed.blocks ?? [])
      if (b.dentistId === dentistId && b.startsAt < to && b.endsAt > from) out.push(b);
    return out;
  }

  async insertAppointment(input: { patientId: string; slot: Slot }) {
    if (this.overlaps(input.slot)) return null;
    const id = `appt_${randomUUID()}`;
    this.appointments.push({
      ...input.slot,
      id,
      patientId: input.patientId,
      status: "PENDING_CONFIRMATION",
      reminderSentAt: null,
    });
    return id;
  }

  async moveAppointment(appointmentId: string, slot: Slot) {
    const appt = this.appointments.find((a) => a.id === appointmentId);
    if (!appt || this.overlaps(slot, appointmentId)) return false;
    Object.assign(appt, slot, { status: "PENDING_CONFIRMATION", reminderSentAt: null });
    return true;
  }

  async appointmentOwner(appointmentId: string) {
    const a = this.appointments.find((x) => x.id === appointmentId);
    return a
      ? {
          patientId: a.patientId,
          procedureId: a.procedureId,
          status: a.status,
          startsAt: a.startsAt,
        }
      : null;
  }

  async confirmAppointment(appointmentId: string) {
    const a = this.appointments.find((x) => x.id === appointmentId);
    if (a?.status === "PENDING_CONFIRMATION") a.status = "CONFIRMED";
  }

  async cancelAppointment(appointmentId: string) {
    const a = this.appointments.find((x) => x.id === appointmentId);
    if (a) a.status = "CANCELLED";
  }

  async patientAppointments(patientId: string, from: Date): Promise<AppointmentInfo[]> {
    return this.appointments
      .filter((a) => a.patientId === patientId && a.status !== "CANCELLED" && a.startsAt >= from)
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
      .map((a) => ({
        id: a.id,
        procedureId: a.procedureId,
        procedureName: this.seed.procedures.find((p) => p.id === a.procedureId)?.name ?? "",
        dentistName: this.seed.dentists.find((d) => d.id === a.dentistId)?.name ?? "",
        startsAt: a.startsAt,
        endsAt: a.endsAt,
        status: a.status,
      }));
  }

  async findPatientByPhone(phone: string) {
    const p = this.patients.find((x) => x.phone === phone);
    return p ? { id: p.id, name: p.name } : null;
  }

  async patientById(patientId: string) {
    return this.patients.find((p) => p.id === patientId) ?? null;
  }

  async markReminderSent(appointmentId: string, at: Date) {
    const a = this.appointments.find((x) => x.id === appointmentId);
    if (a) a.reminderSentAt = at;
  }

  async createPatient(name: string, phone: string) {
    const p = { id: `pat_${randomUUID()}`, name, phone };
    this.patients.push(p);
    return { id: p.id, name: p.name };
  }

  private active(dentistId: string, ignoreAppointmentId?: string) {
    return this.appointments.filter(
      (a) => a.dentistId === dentistId && a.status !== "CANCELLED" && a.id !== ignoreAppointmentId,
    );
  }

  private overlaps(slot: Slot, ignoreAppointmentId?: string) {
    return this.active(slot.dentistId, ignoreAppointmentId).some(
      (a) => slot.startsAt < a.endsAt && slot.endsAt > a.startsAt,
    );
  }
}

/** Same fictitious clinic as prisma/seed.ts: Mon-Fri 8h-12h and 13h-18h. */
export function demoAgendaSeed(clinicId = "clinic_dev"): MemoryAgendaSeed {
  const workingHours = [1, 2, 3, 4, 5].flatMap((weekday) => [
    { weekday, startMinute: 8 * 60, endMinute: 12 * 60 },
    { weekday, startMinute: 13 * 60, endMinute: 18 * 60 },
  ]);
  return {
    clinicId,
    timeZone: "America/Sao_Paulo",
    dentists: [{ id: "dentist_dev", name: "Dra. Exemplo", workingHours }],
    procedures: [
      { id: "proc_avaliacao", name: "Avaliação", durationMinutes: 30, priceCents: null },
      { id: "proc_limpeza", name: "Limpeza (profilaxia)", durationMinutes: 45, priceCents: 25000 },
      { id: "proc_resina", name: "Restauração em resina", durationMinutes: 60, priceCents: 35000 },
      { id: "proc_canal", name: "Tratamento de canal", durationMinutes: 90, priceCents: 120000 },
      { id: "proc_extracao", name: "Extração simples", durationMinutes: 45, priceCents: 30000 },
      { id: "proc_clareamento", name: "Clareamento", durationMinutes: 60, priceCents: 90000 },
    ],
  };
}
