/**
 * Internal scheduling contract. The DentalBOT's own agenda is the source of truth in the
 * MVP; if the clinic adopts a management system later, it becomes another implementation
 * and the bot does not change.
 */
export type Slot = { dentistId: string; procedureId: string; startsAt: Date; endsAt: Date };

export type PatientRef = { id: string; name: string };

export interface AgendaProvider {
  listarHorarios(input: {
    procedureId: string;
    dentistId?: string;
    /** "YYYY-MM-DD" in the clinic timezone. */
    from: string;
    days: number;
  }): Promise<Slot[]>;
  reservar(input: { patientId: string; slot: Slot }): Promise<{ appointmentId: string }>;
  remarcar(input: { appointmentId: string; slot: Slot }): Promise<void>;
  cancelar(input: { appointmentId: string; reason?: string }): Promise<void>;
  buscarPaciente(input: { phone: string }): Promise<PatientRef | null>;
}
