/**
 * Internal scheduling contract. The DentalBOT's own agenda is the source of truth in the
 * MVP; if the clinic adopts a management system later, it becomes another implementation
 * and the bot does not change.
 *
 * An AgendaProvider instance is always bound to ONE clinic (tenant): callers never pass a
 * clinic id, so a tool cannot reach another clinic's data.
 */
import type { WorkingWindow } from "./slots.js";

export type Slot = { dentistId: string; procedureId: string; startsAt: Date; endsAt: Date };

export type PatientRef = { id: string; name: string };

export type ProcedureInfo = {
  id: string;
  name: string;
  durationMinutes: number;
  /** Private price in cents; null = only after evaluation. */
  priceCents: number | null;
};

export type AppointmentInfo = {
  id: string;
  procedureId: string;
  procedureName: string;
  dentistName: string;
  startsAt: Date;
  endsAt: Date;
  status: "PENDING_CONFIRMATION" | "CONFIRMED" | "CANCELLED" | "NO_SHOW" | "COMPLETED";
};

export class SlotUnavailableError extends Error {
  constructor() {
    super("slot no longer available");
    this.name = "SlotUnavailableError";
  }
}

export class AppointmentNotFoundError extends Error {
  constructor() {
    super("appointment not found for this patient");
    this.name = "AppointmentNotFoundError";
  }
}

export interface AgendaProvider {
  readonly clinicId: string;
  readonly timeZone: string;
  listarProcedimentos(): Promise<ProcedureInfo[]>;
  /** Weekly opening hours (union of the dentists' working hours). */
  horariosDeAtendimento(): Promise<WorkingWindow[]>;
  listarHorarios(input: {
    procedureId: string;
    dentistId?: string;
    /** "YYYY-MM-DD" in the clinic timezone. */
    from: string;
    days: number;
  }): Promise<Slot[]>;
  /** Throws SlotUnavailableError if someone else took the slot meanwhile. */
  reservar(input: { patientId: string; slot: Slot }): Promise<{ appointmentId: string }>;
  /** Throws AppointmentNotFoundError if the appointment is not this patient's. */
  remarcar(input: { appointmentId: string; patientId: string; slot: Slot }): Promise<void>;
  cancelar(input: { appointmentId: string; patientId: string; reason?: string }): Promise<void>;
  /** Upcoming, non-cancelled appointments of a patient. */
  consultasDoPaciente(input: { patientId: string; from: Date }): Promise<AppointmentInfo[]>;
  /** `phone` is the normalized wa_id (digits only). */
  buscarPaciente(input: { phone: string }): Promise<PatientRef | null>;
  cadastrarPaciente(input: { name: string; phone: string }): Promise<PatientRef>;
}
