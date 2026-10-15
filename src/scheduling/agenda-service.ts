import {
  AppointmentNotFoundError,
  SlotUnavailableError,
  type AgendaProvider,
  type AppointmentInfo,
  type PatientRef,
  type ProcedureInfo,
  type Slot,
} from "./agenda-provider.js";
import { availableSlots, type BusyInterval, type WorkingWindow } from "./slots.js";
import { addDays, dateInZone, zonedToUtc } from "./time.js";

export type DentistSchedule = { id: string; name: string; workingHours: WorkingWindow[] };

/**
 * Storage port for one clinic's agenda. Implementations: Prisma (production) and in-memory
 * (tests, eval, MCP dev server). Business rules live in AgendaService, not here.
 */
export interface AgendaRepository {
  readonly clinicId: string;
  readonly timeZone: string;
  procedures(): Promise<ProcedureInfo[]>;
  dentists(): Promise<DentistSchedule[]>;
  /** Active appointments and schedule blocks of a dentist overlapping [from, to). */
  busy(
    dentistId: string,
    from: Date,
    to: Date,
    ignoreAppointmentId?: string,
  ): Promise<BusyInterval[]>;
  /**
   * Inserts the appointment unless it overlaps another active one of the same dentist,
   * atomically (concurrent bookings must not double-book). Returns null on conflict.
   */
  insertAppointment(input: { patientId: string; slot: Slot }): Promise<string | null>;
  /** Same atomic overlap check, ignoring the appointment being moved. */
  moveAppointment(appointmentId: string, slot: Slot): Promise<boolean>;
  appointmentOwner(
    appointmentId: string,
  ): Promise<{ patientId: string; status: string; startsAt: Date } | null>;
  cancelAppointment(appointmentId: string): Promise<void>;
  /** PENDING_CONFIRMATION -> CONFIRMED; any other status is left as is. */
  confirmAppointment(appointmentId: string): Promise<void>;
  patientAppointments(patientId: string, from: Date): Promise<AppointmentInfo[]>;
  findPatientByPhone(phone: string): Promise<PatientRef | null>;
  createPatient(name: string, phone: string): Promise<PatientRef>;
}

export type AgendaOptions = {
  now?: () => Date;
  /** Slots starting sooner than this are not offered. */
  minNoticeMinutes?: number;
  stepMinutes?: number;
};

export class AgendaService implements AgendaProvider {
  private readonly now: () => Date;
  private readonly minNoticeMinutes: number;
  private readonly stepMinutes: number;

  constructor(
    private readonly repo: AgendaRepository,
    opts: AgendaOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.minNoticeMinutes = opts.minNoticeMinutes ?? 120;
    this.stepMinutes = opts.stepMinutes ?? 30;
  }

  get clinicId() {
    return this.repo.clinicId;
  }

  get timeZone() {
    return this.repo.timeZone;
  }

  listarProcedimentos() {
    return this.repo.procedures();
  }

  async horariosDeAtendimento() {
    const seen = new Map<string, WorkingWindow>();
    for (const d of await this.repo.dentists())
      for (const w of d.workingHours) seen.set(`${w.weekday}:${w.startMinute}:${w.endMinute}`, w);
    return [...seen.values()].sort(
      (a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute,
    );
  }

  listarHorarios(input: { procedureId: string; dentistId?: string; from: string; days: number }) {
    return this.computeSlots(input);
  }

  private async computeSlots(
    input: { procedureId: string; dentistId?: string; from: string; days: number },
    ignoreAppointmentId?: string,
  ): Promise<Slot[]> {
    const procedure = (await this.repo.procedures()).find((p) => p.id === input.procedureId);
    if (!procedure) return [];
    const dentists = (await this.repo.dentists()).filter(
      (d) => !input.dentistId || d.id === input.dentistId,
    );
    const tz = this.repo.timeZone;
    const slots: Slot[] = [];
    for (let i = 0; i < input.days; i++) {
      const date = addDays(input.from, i);
      const dayStart = zonedToUtc(date, 0, tz);
      const dayEnd = zonedToUtc(addDays(date, 1), 0, tz);
      for (const d of dentists) {
        const busy = await this.repo.busy(d.id, dayStart, dayEnd, ignoreAppointmentId);
        for (const startsAt of availableSlots({
          date,
          timeZone: tz,
          workingHours: d.workingHours,
          busy,
          durationMinutes: procedure.durationMinutes,
          stepMinutes: this.stepMinutes,
          now: this.now(),
          minNoticeMinutes: this.minNoticeMinutes,
        })) {
          slots.push({
            dentistId: d.id,
            procedureId: procedure.id,
            startsAt,
            endsAt: new Date(startsAt.getTime() + procedure.durationMinutes * 60_000),
          });
        }
      }
    }
    return slots.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  }

  async reservar(input: { patientId: string; slot: Slot }) {
    await this.assertBookable(input.slot);
    const id = await this.repo.insertAppointment(input);
    if (!id) throw new SlotUnavailableError();
    return { appointmentId: id };
  }

  async remarcar(input: { appointmentId: string; patientId: string; slot: Slot }) {
    await this.assertOwner(input.appointmentId, input.patientId);
    await this.assertBookable(input.slot, input.appointmentId);
    if (!(await this.repo.moveAppointment(input.appointmentId, input.slot)))
      throw new SlotUnavailableError();
  }

  async cancelar(input: { appointmentId: string; patientId: string; reason?: string }) {
    await this.assertOwner(input.appointmentId, input.patientId);
    await this.repo.cancelAppointment(input.appointmentId);
  }

  async confirmar(input: { appointmentId: string; patientId: string }) {
    const owner = await this.assertOwner(input.appointmentId, input.patientId);
    if (owner.startsAt <= this.now()) throw new AppointmentNotFoundError();
    await this.repo.confirmAppointment(input.appointmentId);
    return { startsAt: owner.startsAt };
  }

  consultasDoPaciente(input: { patientId: string; from: Date }) {
    return this.repo.patientAppointments(input.patientId, input.from);
  }

  buscarPaciente(input: { phone: string }) {
    return this.repo.findPatientByPhone(input.phone);
  }

  cadastrarPaciente(input: { name: string; phone: string }) {
    return this.repo.createPatient(input.name.trim(), input.phone);
  }

  private async assertOwner(appointmentId: string, patientId: string) {
    const owner = await this.repo.appointmentOwner(appointmentId);
    if (!owner || owner.patientId !== patientId || owner.status === "CANCELLED")
      throw new AppointmentNotFoundError();
    return owner;
  }

  /** A slot must still be one we would offer now (working hours, notice, duration). */
  private async assertBookable(slot: Slot, movingAppointmentId?: string) {
    const offered = await this.computeSlots(
      {
        procedureId: slot.procedureId,
        dentistId: slot.dentistId,
        from: dateInZone(slot.startsAt, this.repo.timeZone),
        days: 1,
      },
      movingAppointmentId,
    );
    const match = offered.some(
      (s) =>
        s.startsAt.getTime() === slot.startsAt.getTime() &&
        s.endsAt.getTime() === slot.endsAt.getTime(),
    );
    if (!match) throw new SlotUnavailableError();
  }
}
