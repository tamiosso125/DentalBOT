import { randomUUID } from "node:crypto";
import type { PlanCoverage } from "../conversation/store.js";
import type { InMemoryAgendaRepository } from "../scheduling/memory-agenda.js";
import type {
  AuthorizationCase,
  AuthorizationStatus,
  InsuranceRepository,
} from "./authorizations.js";

type StoredDecision = {
  id: string;
  appointmentId: string;
  planId: string;
  status: AuthorizationStatus;
  decidedAt: Date;
  notifiedAt: Date | null;
  privateChosenAt: Date | null;
};

/** Plans, patient insurance and decisions over the in-memory agenda (tests and the eval). */
export class InMemoryInsuranceRepository implements InsuranceRepository {
  readonly patientPlans = new Map<string, { planId: string; card: string | null }>();
  readonly decisions: StoredDecision[] = [];
  private readonly planList: Array<{ id: string; name: string }>;

  constructor(
    private readonly agenda: InMemoryAgendaRepository,
    private readonly clinicName: string,
    planNames: string[],
    private readonly coverage: PlanCoverage[],
  ) {
    this.planList = planNames.map((name) => ({
      id: `plan_${name.toLowerCase().replace(/\W+/g, "_")}`,
      name,
    }));
  }

  private own(clinicId: string) {
    return clinicId === this.agenda.clinicId;
  }

  async clinic(clinicId: string) {
    return this.own(clinicId) ? { name: this.clinicName, timeZone: this.agenda.timeZone } : null;
  }

  async plans(clinicId: string) {
    return this.own(clinicId) ? this.planList : [];
  }

  async patientInsurance(clinicId: string, patientId: string) {
    if (!this.own(clinicId) || !this.agenda.patients.some((p) => p.id === patientId)) return null;
    const current = this.patientPlans.get(patientId);
    return { planId: current?.planId ?? null, card: current?.card ?? null };
  }

  async setPatientInsurance(
    clinicId: string,
    patientId: string,
    planId: string | null,
    card: string | null,
  ) {
    if (!this.own(clinicId) || !this.agenda.patients.some((p) => p.id === patientId)) return false;
    if (planId) this.patientPlans.set(patientId, { planId, card });
    else this.patientPlans.delete(patientId);
    return true;
  }

  async requiresAuthorization(clinicId: string, patientId: string, procedureId: string) {
    if (!this.own(clinicId)) return false;
    return this.needs(patientId, procedureId);
  }

  async cases(clinicId: string, from: Date) {
    if (!this.own(clinicId)) return [];
    return this.agenda.appointments
      .filter((a) => a.startsAt >= from)
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
      .flatMap((a) => (this.caseFor(a.id) ? [this.caseFor(a.id)!] : []))
      .filter(
        (c) =>
          c.decision ||
          c.appointmentStatus === "PENDING_CONFIRMATION" ||
          c.appointmentStatus === "CONFIRMED",
      );
  }

  async caseOf(clinicId: string, appointmentId: string) {
    return this.own(clinicId) ? this.caseFor(appointmentId) : null;
  }

  async caseOfDecision(clinicId: string, authorizationId: string) {
    const d = this.decisions.find((x) => x.id === authorizationId);
    return this.own(clinicId) && d ? this.caseFor(d.appointmentId) : null;
  }

  async decide(c: AuthorizationCase, status: AuthorizationStatus, at: Date) {
    if (this.decisions.some((d) => d.appointmentId === c.appointmentId)) return null;
    const id = `auth_${randomUUID()}`;
    this.decisions.push({
      id,
      appointmentId: c.appointmentId,
      planId: c.planId,
      status,
      decidedAt: at,
      notifiedAt: null,
      privateChosenAt: null,
    });
    return id;
  }

  async markNotified(authorizationId: string, at: Date) {
    const d = this.decisions.find((x) => x.id === authorizationId);
    if (d) d.notifiedAt = at;
  }

  async choosePrivate(authorizationId: string, at: Date) {
    const d = this.decisions.find((x) => x.id === authorizationId);
    if (!d || d.status !== "DENIED" || d.privateChosenAt) return false;
    d.privateChosenAt = at;
    return true;
  }

  private needs(patientId: string, procedureId: string) {
    const current = this.patientPlans.get(patientId);
    const plan = current && this.planList.find((p) => p.id === current.planId);
    return (
      !!plan &&
      this.coverage.some(
        (c) => c.plan === plan.name && c.procedureId === procedureId && c.requiresAuthorization,
      )
    );
  }

  private caseFor(appointmentId: string): AuthorizationCase | null {
    const a = this.agenda.appointments.find((x) => x.id === appointmentId);
    const patient = a && this.agenda.patients.find((p) => p.id === a.patientId);
    if (!a || !patient) return null;
    const decision = this.decisions.find((d) => d.appointmentId === a.id) ?? null;
    const current = this.patientPlans.get(patient.id);
    const planId = decision?.planId ?? current?.planId;
    const plan = this.planList.find((p) => p.id === planId);
    if (!plan || (!decision && !this.needs(patient.id, a.procedureId))) return null;
    const procedure = this.procedures.find((p) => p.id === a.procedureId);
    return {
      clinicId: this.agenda.clinicId,
      appointmentId: a.id,
      appointmentStatus: a.status,
      startsAt: a.startsAt,
      procedureId: a.procedureId,
      procedureName: procedure?.name ?? "",
      procedurePriceCents: procedure?.priceCents ?? null,
      patientId: patient.id,
      patientName: patient.name,
      phone: patient.phone,
      planId: plan.id,
      planName: plan.name,
      card: current?.card ?? null,
      decision: decision
        ? {
            id: decision.id,
            status: decision.status,
            decidedAt: decision.decidedAt,
            notifiedAt: decision.notifiedAt,
            privateChosenAt: decision.privateChosenAt,
          }
        : null,
    };
  }

  private get procedures() {
    return this.agenda.procedureList;
  }
}
