import type { AccessAction, PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { Logger } from "../lib/logger.js";
import { addDays, dateInZone, zonedToUtc } from "../scheduling/time.js";

/**
 * Who touched patient data in the staff panel, for LGPD accountability ("quem mexeu nos meus
 * dados?"). Each entry holds only the action, when, and which patient or record: never names
 * typed in a search, note text, or any other content. The panel has one shared login, so an
 * entry says what was done, not which person did it.
 */

export type { AccessAction };

/** What the admin API records, keyed by "METHOD /route/pattern". */
export type AuditRule = {
  action: AccessAction;
  /** Where the patient comes from: the :id param, the body's patientId, or looked up from the target. */
  patient?: "param" | "body";
  /** The :id param names this kind of record; its patient is looked up when recording. */
  target?: "appointment" | "quote" | "installment" | "dataRequest" | "staffUser";
};

export const AUDITED: Record<string, AuditRule> = {
  "GET /admin/patients": { action: "SEARCH_PATIENTS" },
  "GET /admin/patients/:id": { action: "VIEW_DATA", patient: "param" },
  "GET /admin/patients/:id/record": { action: "VIEW_RECORD", patient: "param" },
  "GET /admin/patients/:id/export": { action: "EXPORT_DATA", patient: "param" },
  "POST /admin/patients/:id/anonymize": { action: "ANONYMIZE", patient: "param" },
  "GET /admin/data-requests/:id/export": { action: "EXPORT_DATA", target: "dataRequest" },
  "POST /admin/data-requests/:id/anonymize": { action: "ANONYMIZE", target: "dataRequest" },
  "GET /admin/patients/:id/medical-history": { action: "VIEW_MEDICAL_HISTORY", patient: "param" },
  "POST /admin/patients/:id/medical-history": { action: "SET_MEDICAL_HISTORY", patient: "param" },
  "GET /admin/patients/:id/clinical-records": { action: "VIEW_CLINICAL_RECORD", patient: "param" },
  "POST /admin/patients/:id/clinical-records": { action: "ADD_CLINICAL_ENTRY", patient: "param" },
  "GET /admin/patients/:id/notes": { action: "VIEW_NOTES", patient: "param" },
  "POST /admin/patients/:id/notes": { action: "ADD_NOTE", patient: "param" },
  "POST /admin/patients/:id/notes/:noteId/delete": { action: "DELETE_NOTE", patient: "param" },
  "GET /admin/patients/:id/insurance": { action: "VIEW_INSURANCE", patient: "param" },
  "POST /admin/patients/:id/insurance": { action: "SET_INSURANCE", patient: "param" },
  "POST /admin/recall/:id/consent": { action: "SET_CONSENT", patient: "param" },
  "GET /admin/appointments/:id": { action: "VIEW_APPOINTMENT", target: "appointment" },
  "GET /admin/quotes/:id": { action: "VIEW_QUOTE", target: "quote" },
  "GET /admin/quotes/:id/pdf": { action: "VIEW_QUOTE_PDF", target: "quote" },
  "POST /admin/installments/:id/receive": { action: "RECEIVE_INSTALLMENT", target: "installment" },
  "POST /admin/clinic-payments": { action: "REGISTER_CLINIC_PAYMENT", patient: "body" },
  "GET /admin/access-log": { action: "VIEW_ACCESS_LOG" },
  "POST /admin/auth/login": { action: "LOGIN" },
  "POST /admin/staff/bootstrap": { action: "MANAGE_STAFF" },
  "POST /admin/staff": { action: "MANAGE_STAFF" },
  "POST /admin/staff/:id/active": { action: "MANAGE_STAFF", target: "staffUser" },
  "POST /admin/staff/:id/password": { action: "MANAGE_STAFF", target: "staffUser" },
};

export type AccessEvent = {
  rule: AuditRule;
  /** The route's :id param, if any. */
  id?: string;
  /** The request body, read only for `patient: "body"`. */
  body?: unknown;
  /** Who was signed in to the panel. */
  staffUserId?: string;
};

export type AccessEntry = {
  id: string;
  at: string;
  action: AccessAction;
  patientId: string | null;
  /** Current name on the record ("Paciente anonimizado" after anonymization), null if none. */
  patientName: string | null;
  /** The staff member signed in, null before personal logins existed. */
  staffName: string | null;
  targetId: string | null;
};

export type AccessLogPage = {
  from: string;
  to: string;
  entries: AccessEntry[];
  /** More entries matched than the page shows. */
  truncated: boolean;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const querySchema = z.object({
  patientId: z.string().min(1).max(64).optional(),
  from: z.string().regex(DAY).optional(),
  to: z.string().regex(DAY).optional(),
});
const PAGE = 500;
const DEFAULT_DAYS = 30;
const MAX_DAYS = 366;

export class AccessLogError extends Error {
  constructor(
    readonly status: 400,
    message: string,
  ) {
    super(message);
    this.name = "AccessLogError";
  }
}

export class AccessLog {
  constructor(private readonly deps: { db: PrismaClient; logger: Logger }) {}

  /** Records one access. Lookups are scoped by clinic; an unknown target keeps its id only. */
  async record(clinicId: string, event: AccessEvent, at: Date): Promise<void> {
    const { rule, id } = event;
    let patientId: string | null = null;
    if (rule.patient === "param") patientId = id ?? null;
    if (rule.patient === "body") {
      const p = (event.body as { patientId?: unknown } | undefined)?.patientId;
      patientId = typeof p === "string" && p.length <= 64 ? p : null;
    }
    if (rule.target && id) patientId = await this.patientOf(clinicId, rule.target, id);
    await this.deps.db.accessLog.create({
      data: {
        clinicId,
        action: rule.action,
        patientId,
        targetId: rule.target ? id : null,
        staffUserId: event.staffUserId ?? null,
        at,
      },
    });
  }

  private async patientOf(
    clinicId: string,
    target: NonNullable<AuditRule["target"]>,
    id: string,
  ): Promise<string | null> {
    const db = this.deps.db;
    switch (target) {
      case "appointment":
        return (
          (await db.appointment.findFirst({ where: { id, clinicId }, select: { patientId: true } }))
            ?.patientId ?? null
        );
      case "quote":
        return (
          (await db.quote.findFirst({ where: { id, clinicId }, select: { patientId: true } }))
            ?.patientId ?? null
        );
      case "installment":
        return (
          (
            await db.installment.findFirst({
              where: { id, quote: { clinicId } },
              select: { quote: { select: { patientId: true } } },
            })
          )?.quote.patientId ?? null
        );
      case "staffUser":
        return null;
      case "dataRequest": {
        const r = await db.dataSubjectRequest.findFirst({
          where: { id, clinicId },
          select: { conversationId: true },
        });
        if (!r) return null;
        return (
          (
            await db.conversation.findFirst({
              where: { id: r.conversationId, clinicId },
              select: { patientId: true },
            })
          )?.patientId ?? null
        );
      }
    }
  }

  /** Newest first, by day in the clinic's timezone. Defaults to the last 30 days. */
  async list(clinicId: string, query: unknown, now: Date): Promise<AccessLogPage> {
    const q = querySchema.safeParse(query);
    if (!q.success) throw new AccessLogError(400, "Filtro inválido.");
    const clinic = await this.deps.db.clinic.findUnique({
      where: { id: clinicId },
      select: { timezone: true },
    });
    const tz = clinic?.timezone ?? "America/Sao_Paulo";
    const to = q.data.to ?? dateInZone(now, tz);
    const from = q.data.from ?? addDays(to, -(DEFAULT_DAYS - 1));
    if (from > to || addDays(from, MAX_DAYS) <= to)
      throw new AccessLogError(400, "Escolha um período de até um ano.");

    const rows = await this.deps.db.accessLog.findMany({
      where: {
        clinicId,
        ...(q.data.patientId ? { patientId: q.data.patientId } : {}),
        at: { gte: zonedToUtc(from, 0, tz), lt: zonedToUtc(addDays(to, 1), 0, tz) },
      },
      orderBy: { at: "desc" },
      take: PAGE + 1,
      include: { staffUser: { select: { name: true } } },
    });
    const page = rows.slice(0, PAGE);
    const ids = [...new Set(page.flatMap((r) => (r.patientId ? [r.patientId] : [])))];
    const patients = ids.length
      ? await this.deps.db.patient.findMany({
          where: { clinicId, id: { in: ids } },
          select: { id: true, name: true },
        })
      : [];
    const names = new Map(patients.map((p) => [p.id, p.name]));
    return {
      from,
      to,
      truncated: rows.length > PAGE,
      entries: page.map((r) => ({
        id: r.id,
        at: r.at.toISOString(),
        action: r.action,
        patientId: r.patientId,
        patientName: r.patientId ? (names.get(r.patientId) ?? null) : null,
        staffName: r.staffUser?.name ?? null,
        targetId: r.targetId,
      })),
    };
  }

  /** Deletes entries older than the retention period. */
  async purge(retentionDays: number, now: Date): Promise<number> {
    const before = new Date(now.getTime() - retentionDays * 86_400_000);
    const { count } = await this.deps.db.accessLog.deleteMany({ where: { at: { lt: before } } });
    if (count > 0) this.deps.logger.info({ count }, "access log purged");
    return count;
  }
}
