import type { Prisma, PrismaClient } from "@prisma/client";
import type { FieldCipher } from "../privacy/index.js";
import type { AppointmentInfo, Slot } from "./agenda-provider.js";
import { AgendaService, type AgendaOptions, type AgendaRepository } from "./agenda-service.js";

const ACTIVE = { not: "CANCELLED" } as const;

/** Postgres agenda of one clinic. Phone numbers only go in encrypted, looked up by hash. */
export class PrismaAgendaRepository implements AgendaRepository {
  constructor(
    private readonly db: PrismaClient,
    private readonly cipher: FieldCipher,
    readonly clinicId: string,
    readonly timeZone: string,
  ) {}

  async procedures() {
    return this.db.procedure.findMany({
      where: { clinicId: this.clinicId, active: true },
      select: { id: true, name: true, durationMinutes: true, priceCents: true },
      orderBy: { name: "asc" },
    });
  }

  async dentists() {
    const rows = await this.db.dentist.findMany({
      where: { clinicId: this.clinicId, active: true },
      include: { workingHours: true },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((d) => ({
      id: d.id,
      name: d.name,
      workingHours: d.workingHours.map(({ weekday, startMinute, endMinute }) => ({
        weekday,
        startMinute,
        endMinute,
      })),
    }));
  }

  async busy(dentistId: string, from: Date, to: Date, ignoreAppointmentId?: string) {
    return busyIn(this.db, this.clinicId, dentistId, from, to, ignoreAppointmentId);
  }

  async insertAppointment(input: { patientId: string; slot: Slot }) {
    return this.db.$transaction(async (tx) => {
      if (!(await this.lockAndCheck(tx, input.slot))) return null;
      const appt = await tx.appointment.create({
        data: {
          clinicId: this.clinicId,
          patientId: input.patientId,
          dentistId: input.slot.dentistId,
          procedureId: input.slot.procedureId,
          startsAt: input.slot.startsAt,
          endsAt: input.slot.endsAt,
        },
      });
      return appt.id;
    });
  }

  async moveAppointment(appointmentId: string, slot: Slot) {
    return this.db.$transaction(async (tx) => {
      if (!(await this.lockAndCheck(tx, slot, appointmentId))) return false;
      const { count } = await tx.appointment.updateMany({
        where: { id: appointmentId, clinicId: this.clinicId },
        data: {
          dentistId: slot.dentistId,
          procedureId: slot.procedureId,
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          status: "PENDING_CONFIRMATION",
          // New date, new reminder.
          reminderSentAt: null,
        },
      });
      return count === 1;
    });
  }

  async appointmentOwner(appointmentId: string) {
    const a = await this.db.appointment.findFirst({
      where: { id: appointmentId, clinicId: this.clinicId },
      select: { patientId: true, procedureId: true, status: true, startsAt: true },
    });
    return a;
  }

  async cancelAppointment(appointmentId: string) {
    await this.db.appointment.updateMany({
      where: { id: appointmentId, clinicId: this.clinicId },
      data: { status: "CANCELLED" },
    });
  }

  async confirmAppointment(appointmentId: string) {
    await this.db.appointment.updateMany({
      where: { id: appointmentId, clinicId: this.clinicId, status: "PENDING_CONFIRMATION" },
      data: { status: "CONFIRMED" },
    });
  }

  async patientAppointments(patientId: string, from: Date): Promise<AppointmentInfo[]> {
    const rows = await this.db.appointment.findMany({
      where: { clinicId: this.clinicId, patientId, status: ACTIVE, startsAt: { gte: from } },
      include: { procedure: { select: { name: true } }, dentist: { select: { name: true } } },
      orderBy: { startsAt: "asc" },
    });
    return rows.map((a) => ({
      id: a.id,
      procedureId: a.procedureId,
      procedureName: a.procedure.name,
      dentistName: a.dentist.name,
      startsAt: a.startsAt,
      endsAt: a.endsAt,
      status: a.status,
    }));
  }

  async findPatientByPhone(phone: string) {
    return this.db.patient.findUnique({
      where: {
        clinicId_phoneHash: { clinicId: this.clinicId, phoneHash: this.cipher.hash(phone) },
      },
      select: { id: true, name: true },
    });
  }

  async patientById(patientId: string) {
    const p = await this.db.patient.findFirst({
      where: { id: patientId, clinicId: this.clinicId },
      select: { id: true, name: true, phoneEncrypted: true },
    });
    return p ? { id: p.id, name: p.name, phone: this.cipher.decrypt(p.phoneEncrypted) } : null;
  }

  async markReminderSent(appointmentId: string, at: Date) {
    await this.db.appointment.updateMany({
      where: { id: appointmentId, clinicId: this.clinicId },
      data: { reminderSentAt: at },
    });
  }

  async createPatient(name: string, phone: string) {
    const phoneHash = this.cipher.hash(phone);
    return this.db.patient.upsert({
      where: { clinicId_phoneHash: { clinicId: this.clinicId, phoneHash } },
      create: {
        clinicId: this.clinicId,
        name,
        phoneHash,
        phoneEncrypted: this.cipher.encrypt(phone),
      },
      update: {},
      select: { id: true, name: true },
    });
  }

  /** Serializes bookings per dentist with a transaction-scoped advisory lock. */
  private async lockAndCheck(tx: Prisma.TransactionClient, slot: Slot, ignoreId?: string) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${slot.dentistId}))`;
    const dentist = await tx.dentist.findFirst({
      where: { id: slot.dentistId, clinicId: this.clinicId },
      select: { id: true },
    });
    if (!dentist) return false;
    const busy = await busyIn(
      tx,
      this.clinicId,
      slot.dentistId,
      slot.startsAt,
      slot.endsAt,
      ignoreId,
    );
    return busy.length === 0;
  }
}

async function busyIn(
  db: Prisma.TransactionClient | PrismaClient,
  clinicId: string,
  dentistId: string,
  from: Date,
  to: Date,
  ignoreAppointmentId?: string,
) {
  const [appointments, blocks] = await Promise.all([
    db.appointment.findMany({
      where: {
        clinicId,
        dentistId,
        status: ACTIVE,
        startsAt: { lt: to },
        endsAt: { gt: from },
        ...(ignoreAppointmentId ? { id: { not: ignoreAppointmentId } } : {}),
      },
      select: { startsAt: true, endsAt: true },
    }),
    db.scheduleBlock.findMany({
      where: { dentistId, startsAt: { lt: to }, endsAt: { gt: from } },
      select: { startsAt: true, endsAt: true },
    }),
  ]);
  return [...appointments, ...blocks];
}

/** Builds the agenda of a clinic, loading its timezone. Returns null for unknown clinics. */
export async function prismaAgendaFor(
  db: PrismaClient,
  cipher: FieldCipher,
  clinicId: string,
  opts?: AgendaOptions,
) {
  const clinic = await db.clinic.findUnique({
    where: { id: clinicId },
    select: { timezone: true },
  });
  if (!clinic) return null;
  return new AgendaService(new PrismaAgendaRepository(db, cipher, clinicId, clinic.timezone), opts);
}
