import { Prisma, type PrismaClient } from "@prisma/client";
import type { FieldCipher } from "../privacy/index.js";
import type {
  AuthorizationCase,
  AuthorizationStatus,
  InsuranceRepository,
} from "./authorizations.js";

const caseSelect = {
  id: true,
  clinicId: true,
  status: true,
  startsAt: true,
  procedureId: true,
  procedure: { select: { name: true, priceCents: true } },
  patient: {
    select: {
      id: true,
      name: true,
      phoneEncrypted: true,
      insuranceCardEncrypted: true,
      insurancePlan: {
        select: {
          id: true,
          name: true,
          coverages: { where: { requiresAuthorization: true }, select: { procedureId: true } },
        },
      },
    },
  },
  authorization: {
    select: {
      id: true,
      status: true,
      decidedAt: true,
      notifiedAt: true,
      privateChosenAt: true,
      insurancePlan: { select: { id: true, name: true } },
    },
  },
} satisfies Prisma.AppointmentSelect;

type Row = Prisma.AppointmentGetPayload<{ select: typeof caseSelect }>;

export class PrismaInsuranceRepository implements InsuranceRepository {
  constructor(
    private readonly db: PrismaClient,
    private readonly cipher: FieldCipher,
  ) {}

  async clinic(clinicId: string) {
    const c = await this.db.clinic.findUnique({
      where: { id: clinicId },
      select: { name: true, timezone: true },
    });
    return c ? { name: c.name, timeZone: c.timezone } : null;
  }

  async plans(clinicId: string) {
    return this.db.insurancePlan.findMany({
      where: { clinicId },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    });
  }

  async patientInsurance(clinicId: string, patientId: string) {
    const p = await this.db.patient.findFirst({
      where: { id: patientId, clinicId, anonymizedAt: null },
      select: { insurancePlanId: true, insuranceCardEncrypted: true },
    });
    if (!p) return null;
    return {
      planId: p.insurancePlanId,
      card: p.insuranceCardEncrypted ? this.cipher.decrypt(p.insuranceCardEncrypted) : null,
    };
  }

  async setPatientInsurance(
    clinicId: string,
    patientId: string,
    planId: string | null,
    card: string | null,
  ) {
    const { count } = await this.db.patient.updateMany({
      where: { id: patientId, clinicId, anonymizedAt: null },
      data: {
        insurancePlanId: planId,
        insuranceCardEncrypted: planId && card ? this.cipher.encrypt(card) : null,
      },
    });
    return count === 1;
  }

  async requiresAuthorization(clinicId: string, patientId: string, procedureId: string) {
    const n = await this.db.patient.count({
      where: {
        id: patientId,
        clinicId,
        insurancePlan: { coverages: { some: { procedureId, requiresAuthorization: true } } },
      },
    });
    return n > 0;
  }

  async cases(clinicId: string, from: Date) {
    const rows = await this.db.appointment.findMany({
      where: {
        clinicId,
        startsAt: { gte: from },
        patient: { anonymizedAt: null },
        OR: [
          { authorization: { isNot: null } },
          {
            status: { in: ["PENDING_CONFIRMATION", "CONFIRMED"] },
            patient: { insurancePlanId: { not: null } },
          },
        ],
      },
      orderBy: { startsAt: "asc" },
      take: 500,
      select: caseSelect,
    });
    return rows.flatMap((r) => this.toCase(r) ?? []);
  }

  async caseOf(clinicId: string, appointmentId: string) {
    const r = await this.db.appointment.findFirst({
      where: { id: appointmentId, clinicId, patient: { anonymizedAt: null } },
      select: caseSelect,
    });
    return r ? this.toCase(r) : null;
  }

  async caseOfDecision(clinicId: string, authorizationId: string) {
    const r = await this.db.appointment.findFirst({
      where: { clinicId, authorization: { id: authorizationId } },
      select: caseSelect,
    });
    return r ? this.toCase(r) : null;
  }

  async decide(c: AuthorizationCase, status: AuthorizationStatus, at: Date) {
    try {
      const a = await this.db.insuranceAuthorization.create({
        data: {
          clinicId: c.clinicId,
          appointmentId: c.appointmentId,
          patientId: c.patientId,
          insurancePlanId: c.planId,
          status,
          decidedAt: at,
        },
        select: { id: true },
      });
      return a.id;
    } catch (err) {
      // Unique appointment: someone else recorded it first.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return null;
      throw err;
    }
  }

  async markNotified(authorizationId: string, at: Date) {
    await this.db.insuranceAuthorization.update({
      where: { id: authorizationId },
      data: { notifiedAt: at },
    });
  }

  async choosePrivate(authorizationId: string, at: Date) {
    const { count } = await this.db.insuranceAuthorization.updateMany({
      where: { id: authorizationId, status: "DENIED", privateChosenAt: null },
      data: { privateChosenAt: at },
    });
    return count === 1;
  }

  /** Null when the appointment needs no authorization and has no decision. */
  private toCase(r: Row): AuthorizationCase | null {
    const plan = r.authorization?.insurancePlan ?? r.patient.insurancePlan;
    const needs =
      !!r.patient.insurancePlan &&
      r.patient.insurancePlan.coverages.some((c) => c.procedureId === r.procedureId);
    if (!plan || (!r.authorization && !needs)) return null;
    return {
      clinicId: r.clinicId,
      appointmentId: r.id,
      appointmentStatus: r.status,
      startsAt: r.startsAt,
      procedureId: r.procedureId,
      procedureName: r.procedure.name,
      procedurePriceCents: r.procedure.priceCents,
      patientId: r.patient.id,
      patientName: r.patient.name,
      phone: this.cipher.decrypt(r.patient.phoneEncrypted),
      planId: plan.id,
      planName: plan.name,
      card: r.patient.insuranceCardEncrypted
        ? this.cipher.decrypt(r.patient.insuranceCardEncrypted)
        : null,
      decision: r.authorization
        ? {
            id: r.authorization.id,
            status: r.authorization.status,
            decidedAt: r.authorization.decidedAt,
            notifiedAt: r.authorization.notifiedAt,
            privateChosenAt: r.authorization.privateChosenAt,
          }
        : null,
    };
  }
}
