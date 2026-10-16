import type { z } from "zod";
import { timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import type { Logger } from "../lib/logger.js";
import { asaasWebhookSchema, type AsaasWebhookEvent } from "../payments/asaas.js";
import {
  agendaQuerySchema,
  patientQuerySchema,
  quoteQuerySchema,
  type PanelQueries,
} from "../panel/panel-queries.js";
import { BillingError, installmentQuerySchema, type Billing } from "../panel/billing.js";
import { ClinicSetupError, type ClinicSetup } from "../panel/clinic-setup.js";
import { PatientDataError, type PatientData, type SubjectRef } from "../panel/patient-data.js";
import { RecallError, type RecallService } from "../recall/recall.js";
import { InsuranceError, type InsuranceAuthorizations } from "../insurance/authorizations.js";
import type { SurveyService } from "../survey/survey.js";
import type { AftercareService } from "../aftercare/aftercare.js";
import { reportQuerySchema, type MonthlyReports } from "../panel/monthly-report.js";
import { ClinicPaymentError, type ClinicPayments } from "../payments/clinic-payments.js";
import { WaitlistError, type WaitlistService } from "../waitlist/waitlist.js";
import { QuoteValidationError, type QuoteService } from "../quotes/quote-service.js";
import { StaffAgendaError, type StaffAgenda } from "../scheduling/staff-agenda.js";
import type { JobQueue } from "../queue/queue.js";
import type { PatientRecords } from "../panel/patient-record.js";
import { PatientNoteError, type PatientNotes } from "../panel/patient-notes.js";
import { AccessLogError, AUDITED, type AccessLog } from "../panel/access-log.js";
import { StaffError, type StaffActor, type StaffService } from "../staff/staff.js";
import {
  AttendanceCertificateError,
  type AttendanceCertificates,
} from "../panel/attendance-certificate.js";
import { DaySheetError, daySheetQuerySchema, type DaySheets } from "../panel/day-sheet.js";
import { ClinicalRecordError, type ClinicalRecords } from "../panel/clinical-record.js";
import { MedicalHistoryError, type MedicalHistories } from "../panel/medical-history.js";
import {
  isValidSignature,
  normalizeWebhook,
  webhookPayloadSchema,
  type SandboxChannel,
  type WhatsAppEvent,
} from "../whatsapp/index.js";

export type ServerDeps = {
  logger: Logger;
  whatsappQueue: JobQueue<WhatsAppEvent>;
  asaasQueue: JobQueue<AsaasWebhookEvent>;
  config: {
    whatsappVerifyToken: string;
    whatsappAppSecret: string;
    asaasWebhookToken: string;
  };
  /**
   * Clinic staff API (the panel will use it). Bearer token, single clinic.
   * Absent = routes not registered.
   */
  admin?: {
    token: string;
    clinicId: string;
    quotes: QuoteService;
    panel: PanelQueries;
    /** Book, move and cancel appointments. Absent = agenda is read-only. */
    agenda?: StaffAgenda;
    /** LGPD requests: export and anonymize a patient's data. Absent = routes not registered. */
    patientData?: PatientData;
    /** Clinic registration (data, dentists, hours, procedures, blocks). Absent = not registered. */
    setup?: ClinicSetup;
    /** Installments and payment links ("Cobranças"). Absent = routes not registered. */
    billing?: Billing;
    /** Recall ("Retorno"): candidates and marketing consent. Absent = routes not registered. */
    recall?: Pick<RecallService, "list" | "setConsent">;
    /** Waiting list ("Lista de espera"). Absent = routes not registered. */
    waitlist?: Pick<WaitlistService, "list" | "add" | "remove">;
    /** Payments received at the front desk. Absent = routes not registered. */
    clinicPayments?: Pick<ClinicPayments, "receiveInstallment" | "register" | "list" | "void">;
    /** Month at a glance for the dentist. Absent = route not registered. */
    report?: MonthlyReports;
    /** Patient record ("Ficha do paciente"). Absent = route not registered. */
    records?: PatientRecords;
    /** Staff notes on the patient record. Absent = routes not registered. */
    notes?: Pick<PatientNotes, "list" | "add" | "remove">;
    /** Medical history (anamnese) on the patient record. Absent = routes not registered. */
    medicalHistory?: Pick<MedicalHistories, "view" | "save">;
    /** Clinical record entries signed by the dentist. Absent = routes not registered. */
    clinicalRecords?: Pick<ClinicalRecords, "list" | "add">;
    /** Attendance certificate PDFs. Absent = route not registered. */
    certificates?: Pick<AttendanceCertificates, "pdf">;
    /** Printable day sheet PDF. Absent = route not registered. */
    daySheets?: Pick<DaySheets, "pdf">;
    /** Records access to patient data and lists it ("Acessos"). Absent = nothing recorded. */
    accessLog?: Pick<AccessLog, "record" | "list">;
    /**
     * Personal staff logins. The panel sends the signed-in person's id in `x-staff-user`;
     * an unknown or deactivated id gets 401. Absent = no staff routes, no actor.
     */
    staff?: Pick<
      StaffService,
      | "hasUsers"
      | "bootstrap"
      | "login"
      | "actor"
      | "list"
      | "create"
      | "setActive"
      | "resetPassword"
      | "changeOwnPassword"
    >;
    /** Satisfaction survey summary. Absent = route not registered. */
    survey?: Pick<SurveyService, "summary">;
    /** Post-procedure follow-ups and help requests. Absent = route not registered. */
    aftercare?: Pick<AftercareService, "summary">;
    /** Insurance authorizations and the patient's plan. Absent = routes not registered. */
    insurance?: Pick<
      InsuranceAuthorizations,
      "list" | "decide" | "patientInsurance" | "setPatientInsurance"
    >;
    now?: () => Date;
  };
  /** Only set in sandbox mode outside production: exposes the fake outbox for dev tools. */
  sandbox?: SandboxChannel;
};

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
    /** The staff member signed in to the panel, on /admin/* routes. */
    staff?: StaffActor;
  }
}

function safeEqual(a: string | undefined, b: string): boolean {
  if (a === undefined) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function buildServer(deps: ServerDeps) {
  const app = Fastify({
    loggerInstance: deps.logger,
    bodyLimit: 1_048_576,
    // Request logs carry no bodies or query strings (hub.verify_token, phone numbers).
    disableRequestLogging: true,
  });

  // Keep the raw bytes: Meta signs the exact body it sent.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    req.rawBody = body as Buffer;
    try {
      done(null, (body as Buffer).length ? JSON.parse((body as Buffer).toString("utf8")) : {});
    } catch {
      const err = new Error("Invalid JSON") as Error & { statusCode: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  app.get("/health", async () => ({ status: "ok" }));

  // Meta webhook verification handshake.
  app.get("/webhooks/whatsapp", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    if (
      q["hub.mode"] === "subscribe" &&
      safeEqual(q["hub.verify_token"], deps.config.whatsappVerifyToken)
    ) {
      return reply.type("text/plain").send(q["hub.challenge"] ?? "");
    }
    return reply.code(403).send();
  });

  app.post("/webhooks/whatsapp", async (req, reply) => {
    const signature = req.headers["x-hub-signature-256"];
    if (
      !req.rawBody ||
      !isValidSignature(
        req.rawBody,
        typeof signature === "string" ? signature : undefined,
        deps.config.whatsappAppSecret,
      )
    ) {
      deps.logger.warn("whatsapp webhook with invalid signature");
      return reply.code(401).send();
    }

    const parsed = webhookPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      // Answer 200 anyway: a payload we cannot read will not get better on retry.
      deps.logger.warn({ issues: parsed.error.issues.length }, "unrecognized whatsapp payload");
      return reply.code(200).send();
    }

    for (const event of normalizeWebhook(parsed.data)) {
      const suffix = event.kind === "status" ? `_${event.status}` : "";
      await deps.whatsappQueue.enqueue(event, {
        jobId: `wa_${event.kind}_${event.waMessageId}${suffix}`,
      });
    }
    return reply.code(200).send();
  });

  app.post("/webhooks/asaas", async (req, reply) => {
    const token = req.headers["asaas-access-token"];
    if (!safeEqual(typeof token === "string" ? token : undefined, deps.config.asaasWebhookToken)) {
      deps.logger.warn("asaas webhook with invalid token");
      return reply.code(401).send();
    }
    const parsed = asaasWebhookSchema.safeParse(req.body);
    if (!parsed.success) {
      deps.logger.warn({ issues: parsed.error.issues.length }, "unrecognized asaas payload");
      return reply.code(200).send();
    }
    await deps.asaasQueue.enqueue(parsed.data, { jobId: `asaas_${parsed.data.id}` });
    return reply.code(200).send({ received: true });
  });

  if (deps.admin) {
    const admin = deps.admin;
    app.register(async (scope) => {
      scope.addHook("onRequest", async (req, reply) => {
        const auth = req.headers.authorization;
        const token =
          typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
        if (!safeEqual(token, admin.token)) return reply.code(401).send();
        const staffId = req.headers["x-staff-user"];
        if (admin.staff && typeof staffId === "string" && staffId) {
          const actor = await admin.staff.actor(admin.clinicId, staffId);
          if (!actor) return reply.code(401).send({ error: "session" });
          req.staff = actor;
        }
      });
      scope.setErrorHandler((err, _req, reply) => {
        if (err instanceof QuoteValidationError)
          return reply.code(422).send({ error: err.message });
        if (
          err instanceof StaffAgendaError ||
          err instanceof PatientDataError ||
          err instanceof ClinicSetupError ||
          err instanceof BillingError ||
          err instanceof RecallError ||
          err instanceof WaitlistError ||
          err instanceof InsuranceError ||
          err instanceof ClinicPaymentError ||
          err instanceof PatientNoteError ||
          err instanceof AccessLogError ||
          err instanceof StaffError ||
          err instanceof MedicalHistoryError ||
          err instanceof ClinicalRecordError ||
          err instanceof AttendanceCertificateError ||
          err instanceof DaySheetError
        )
          return reply.code(err.status).send({ error: err.message });
        if (err instanceof BadQueryError) return reply.code(400).send({ error: "bad query" });
        const status = (err as { statusCode?: number }).statusCode;
        // Fastify's own client errors (malformed JSON, wrong content type).
        if (status && status >= 400 && status < 500)
          return reply.code(status).send({ error: "bad request" });
        deps.logger.error(
          { err: err instanceof Error ? err.name : "unknown" },
          "admin route failed",
        );
        return reply.code(500).send({ error: "internal error" });
      });

      const accessLog = admin.accessLog;
      if (accessLog) {
        // Recorded before the response leaves, so whoever got patient data left a trace.
        // A failure to record is logged and does not block the clinic's work.
        scope.addHook("onSend", async (req, reply, payload) => {
          if (reply.statusCode >= 300) return payload;
          const rule = AUDITED[`${req.method} ${req.routeOptions.url}`];
          if (!rule) return payload;
          const id = (req.params as { id?: string } | undefined)?.id;
          try {
            await accessLog.record(
              admin.clinicId,
              { rule, id, body: req.body, staffUserId: req.staff?.id },
              admin.now?.() ?? new Date(),
            );
          } catch (err) {
            deps.logger.error(
              { err: err instanceof Error ? err.name : "unknown", action: rule.action },
              "access log write failed",
            );
          }
          return payload;
        });
        scope.get("/admin/access-log", async (req) =>
          accessLog.list(admin.clinicId, req.query, admin.now?.() ?? new Date()),
        );
      }

      const logins = admin.staff;
      if (logins) {
        const now = () => admin.now?.() ?? new Date();
        const signedIn = (req: { staff?: StaffActor }) => {
          if (!req.staff) throw new StaffError(401, "Entre com o seu login.");
          return req.staff;
        };
        type Id = { Params: { id: string } };
        scope.get("/admin/staff/status", async () => ({
          hasUsers: await logins.hasUsers(admin.clinicId),
        }));
        scope.post("/admin/staff/bootstrap", async (req, reply) => {
          req.staff = await logins.bootstrap(admin.clinicId, req.body, now());
          return reply.code(201).send(req.staff);
        });
        scope.post("/admin/auth/login", async (req) => {
          req.staff = await logins.login(admin.clinicId, req.body, now());
          return req.staff;
        });
        scope.get("/admin/staff", async (req) => {
          if (signedIn(req).role !== "DENTIST")
            throw new StaffError(403, "Só a dentista cuida dos logins.");
          return logins.list(admin.clinicId);
        });
        scope.post("/admin/staff", async (req, reply) =>
          reply.code(201).send(await logins.create(admin.clinicId, signedIn(req), req.body, now())),
        );
        scope.post<Id>("/admin/staff/:id/active", async (req, reply) => {
          await logins.setActive(admin.clinicId, signedIn(req), req.params.id, req.body);
          return reply.code(204).send();
        });
        scope.post<Id>("/admin/staff/:id/password", async (req, reply) => {
          await logins.resetPassword(admin.clinicId, signedIn(req), req.params.id, req.body);
          return reply.code(204).send();
        });
        scope.post("/admin/me/password", async (req, reply) => {
          await logins.changeOwnPassword(admin.clinicId, signedIn(req), req.body);
          return reply.code(204).send();
        });
      }

      // Read side for the staff panel. Query strings are validated; 400 on anything else.
      const parse = <T>(schema: z.ZodType<T>, value: unknown) => {
        const r = schema.safeParse(value);
        if (!r.success) throw new BadQueryError();
        return r.data;
      };
      scope.get("/admin/agenda", async (req) =>
        admin.panel.agenda(admin.clinicId, parse(agendaQuerySchema, req.query)),
      );
      scope.get("/admin/patients", async (req) =>
        admin.panel.patients(admin.clinicId, parse(patientQuerySchema, req.query).q),
      );
      scope.get("/admin/catalog", async (_req, reply) => {
        const c = await admin.panel.catalog(admin.clinicId);
        return c ? c : reply.code(404).send();
      });
      scope.get("/admin/quotes", async (req) =>
        admin.panel.quotes(admin.clinicId, parse(quoteQuerySchema, req.query).status),
      );
      scope.get("/admin/attendance", async () =>
        admin.panel.attendance(admin.clinicId, admin.now?.() ?? new Date()),
      );
      scope.get("/admin/handoffs", async () =>
        admin.panel.handoffs(admin.clinicId, admin.now?.() ?? new Date()),
      );

      scope.post("/admin/quotes", async (req, reply) =>
        reply.code(201).send(await admin.quotes.create(admin.clinicId, req.body)),
      );
      scope.get("/admin/quotes/follow-up", async () =>
        admin.panel.quoteFollowUp(admin.clinicId, admin.now?.() ?? new Date()),
      );
      scope.get<{ Params: { id: string } }>("/admin/quotes/:id", async (req, reply) => {
        const q = await admin.quotes.get(admin.clinicId, req.params.id);
        return q ? q : reply.code(404).send();
      });
      scope.get<{ Params: { id: string } }>("/admin/quotes/:id/pdf", async (req, reply) => {
        const pdf = await admin.quotes.pdf(admin.clinicId, req.params.id);
        if (!pdf) return reply.code(404).send();
        return reply
          .type("application/pdf")
          .header("content-disposition", `inline; filename="orcamento-${req.params.id}.pdf"`)
          .send(pdf);
      });
      scope.post<{ Params: { id: string } }>("/admin/quotes/:id/send", async (req) =>
        admin.quotes.send(admin.clinicId, req.params.id),
      );

      scope.get<{ Params: { id: string } }>("/admin/appointments/:id", async (req, reply) => {
        const a = await admin.panel.appointment(admin.clinicId, req.params.id);
        return a ? a : reply.code(404).send();
      });
      const staff = admin.agenda;
      if (staff) {
        scope.get("/admin/slots", async (req) => staff.slots(admin.clinicId, req.query));
        scope.post("/admin/appointments", async (req, reply) =>
          reply.code(201).send(await staff.book(admin.clinicId, req.body)),
        );
        scope.post<{ Params: { id: string } }>("/admin/appointments/:id/reschedule", async (req) =>
          staff.reschedule(admin.clinicId, req.params.id, req.body),
        );
        scope.post<{ Params: { id: string } }>(
          "/admin/appointments/:id/attendance",
          async (req, reply) => {
            await staff.attendance(admin.clinicId, req.params.id, req.body);
            return reply.code(204).send();
          },
        );
        scope.post<{ Params: { id: string } }>(
          "/admin/appointments/:id/resend-confirmation",
          async (req, reply) => {
            await staff.resendConfirmation(admin.clinicId, req.params.id);
            return reply.code(204).send();
          },
        );
        scope.post<{ Params: { id: string } }>(
          "/admin/appointments/:id/cancel",
          async (req, reply) => {
            await staff.cancel(admin.clinicId, req.params.id);
            return reply.code(204).send();
          },
        );
      }

      const data = admin.patientData;
      if (data) {
        const now = () => admin.now?.() ?? new Date();
        scope.get("/admin/data-requests", async () => data.dataRequests(admin.clinicId));
        scope.post<{ Params: { id: string } }>(
          "/admin/data-requests/:id/resolve",
          async (req, reply) => {
            await data.resolveRequest(admin.clinicId, req.params.id, now());
            return reply.code(204).send();
          },
        );
        scope.get<{ Params: { id: string } }>("/admin/patients/:id", async (req, reply) => {
          const p = await data.summary(admin.clinicId, req.params.id);
          return p ? p : reply.code(404).send();
        });
        // The same two actions, for a registered patient or straight from a "MEUS DADOS" request.
        const subjects: Array<[string, (id: string) => SubjectRef]> = [
          ["/admin/patients/:id", (patientId) => ({ patientId })],
          ["/admin/data-requests/:id", (requestId) => ({ requestId })],
        ];
        for (const [base, ref] of subjects) {
          scope.get<{ Params: { id: string } }>(`${base}/export`, async (req, reply) => {
            const body = await data.export(admin.clinicId, ref(req.params.id), now());
            deps.logger.info({ subject: req.params.id }, "patient data exported");
            return reply
              .header("cache-control", "no-store")
              .header("content-disposition", `attachment; filename="dados-${req.params.id}.json"`)
              .send(body);
          });
          scope.post<{ Params: { id: string } }>(`${base}/anonymize`, async (req) => {
            const result = await data.anonymize(admin.clinicId, ref(req.params.id), now());
            deps.logger.info({ subject: req.params.id, ...result }, "patient data anonymized");
            return result;
          });
        }
      }

      const billing = admin.billing;
      if (billing) {
        const now = () => admin.now?.() ?? new Date();
        scope.get("/admin/installments", async (req) =>
          billing.installments(admin.clinicId, parse(installmentQuerySchema, req.query), now()),
        );
        scope.get("/admin/installments/summary", async () =>
          billing.summary(admin.clinicId, now()),
        );
        scope.get<{ Params: { id: string } }>("/admin/installments/:id/link", async (req, reply) =>
          reply
            .header("cache-control", "no-store")
            .send(await billing.paymentLink(admin.clinicId, req.params.id)),
        );
      }

      const desk = admin.clinicPayments;
      if (desk) {
        const now = () => admin.now?.() ?? new Date();
        type Id = { Params: { id: string } };
        scope.post<Id>("/admin/installments/:id/receive", async (req, reply) => {
          await desk.receiveInstallment(admin.clinicId, req.params.id, req.body, now());
          return reply.code(204).send();
        });
        scope.get("/admin/clinic-payments", async () => desk.list(admin.clinicId, now()));
        scope.post("/admin/clinic-payments", async (req, reply) =>
          reply.code(201).send(await desk.register(admin.clinicId, req.body, now())),
        );
        scope.post<Id>("/admin/clinic-payments/:id/void", async (req, reply) => {
          await desk.void(admin.clinicId, req.params.id, now());
          return reply.code(204).send();
        });
      }

      const recall = admin.recall;
      if (recall) {
        const now = () => admin.now?.() ?? new Date();
        scope.get("/admin/recall", async () => recall.list(admin.clinicId, now()));
        scope.post<{ Params: { id: string } }>("/admin/recall/:id/consent", async (req, reply) => {
          await recall.setConsent(admin.clinicId, req.params.id, req.body, now());
          return reply.code(204).send();
        });
      }

      const waitlist = admin.waitlist;
      if (waitlist) {
        const now = () => admin.now?.() ?? new Date();
        scope.get("/admin/waitlist", async () => waitlist.list(admin.clinicId, now()));
        scope.post("/admin/waitlist", async (req, reply) =>
          reply.code(201).send(await waitlist.add(admin.clinicId, req.body, now())),
        );
        scope.post<{ Params: { id: string } }>("/admin/waitlist/:id/remove", async (req, reply) => {
          await waitlist.remove(admin.clinicId, req.params.id, now());
          return reply.code(204).send();
        });
      }

      const records = admin.records;
      if (records) {
        scope.get<{ Params: { id: string } }>("/admin/patients/:id/record", async (req, reply) => {
          const r = await records.record(
            admin.clinicId,
            req.params.id,
            admin.now?.() ?? new Date(),
          );
          return r ? r : reply.code(404).send();
        });
      }

      const history = admin.medicalHistory;
      if (history) {
        type P = { Params: { id: string } };
        scope.get<P>("/admin/patients/:id/medical-history", async (req) =>
          history.view(admin.clinicId, req.params.id),
        );
        scope.post<P>("/admin/patients/:id/medical-history", async (req, reply) =>
          reply
            .code(201)
            .send(
              await history.save(
                admin.clinicId,
                req.params.id,
                req.body,
                admin.now?.() ?? new Date(),
                req.staff?.id,
              ),
            ),
        );
      }

      const certificates = admin.certificates;
      if (certificates) {
        scope.get<{ Params: { id: string } }>(
          "/admin/appointments/:id/attendance-certificate",
          async (req, reply) =>
            reply
              .type("application/pdf")
              .header("content-disposition", `inline; filename="atestado-${req.params.id}.pdf"`)
              .send(
                await certificates.pdf(admin.clinicId, req.params.id, admin.now?.() ?? new Date()),
              ),
        );
      }

      const daySheets = admin.daySheets;
      if (daySheets) {
        scope.get("/admin/agenda/day-sheet", async (req, reply) => {
          const q = daySheetQuerySchema.safeParse(req.query);
          if (!q.success) throw new BadQueryError();
          return reply
            .type("application/pdf")
            .header("content-disposition", `inline; filename="agenda-${q.data.day}.pdf"`)
            .send(await daySheets.pdf(admin.clinicId, q.data.day));
        });
      }

      const clinical = admin.clinicalRecords;
      if (clinical) {
        type P = { Params: { id: string } };
        scope.get<P>("/admin/patients/:id/clinical-records", async (req) =>
          clinical.list(admin.clinicId, req.params.id),
        );
        // Signed by whoever is logged in: without a personal login there is no signature.
        scope.post<P>("/admin/patients/:id/clinical-records", async (req, reply) => {
          if (!req.staff) throw new ClinicalRecordError(403, "Entre com o seu login para assinar.");
          return reply
            .code(201)
            .send(
              await clinical.add(
                admin.clinicId,
                req.params.id,
                req.staff,
                req.body,
                admin.now?.() ?? new Date(),
              ),
            );
        });
      }

      const notes = admin.notes;
      if (notes) {
        type P = { Params: { id: string } };
        type N = { Params: { id: string; noteId: string } };
        scope.get<P>("/admin/patients/:id/notes", async (req) =>
          notes.list(admin.clinicId, req.params.id),
        );
        scope.post<P>("/admin/patients/:id/notes", async (req, reply) =>
          reply.code(201).send(
            await notes.add(
              admin.clinicId,
              req.params.id,
              // Signed in: the author is whoever wrote it, not a choice in the form.
              req.staff
                ? { ...(isObject(req.body) ? req.body : {}), author: req.staff.role }
                : req.body,
              admin.now?.() ?? new Date(),
              req.staff?.id,
            ),
          ),
        );
        scope.post<N>("/admin/patients/:id/notes/:noteId/delete", async (req, reply) => {
          await notes.remove(admin.clinicId, req.params.id, req.params.noteId);
          return reply.code(204).send();
        });
      }

      const report = admin.report;
      if (report) {
        scope.get("/admin/report", async (req) =>
          report.report(
            admin.clinicId,
            parse(reportQuerySchema, req.query).mes,
            admin.now?.() ?? new Date(),
          ),
        );
      }

      const survey = admin.survey;
      if (survey) {
        const now = () => admin.now?.() ?? new Date();
        scope.get("/admin/surveys", async () => survey.summary(admin.clinicId, now()));
      }

      const aftercare = admin.aftercare;
      if (aftercare) {
        const now = () => admin.now?.() ?? new Date();
        scope.get("/admin/aftercare", async () => aftercare.summary(admin.clinicId, now()));
      }

      const insurance = admin.insurance;
      if (insurance) {
        const now = () => admin.now?.() ?? new Date();
        type Id = { Params: { id: string } };
        scope.get("/admin/authorizations", async () => insurance.list(admin.clinicId, now()));
        scope.post<Id>("/admin/authorizations/:id", async (req) =>
          insurance.decide(admin.clinicId, req.params.id, req.body, now()),
        );
        scope.get<Id>("/admin/patients/:id/insurance", async (req) =>
          insurance.patientInsurance(admin.clinicId, req.params.id),
        );
        scope.post<Id>("/admin/patients/:id/insurance", async (req, reply) => {
          await insurance.setPatientInsurance(admin.clinicId, req.params.id, req.body);
          return reply.code(204).send();
        });
      }

      const setup = admin.setup;
      if (setup) {
        type Id = { Params: { id: string } };
        scope.get("/admin/setup", async () =>
          setup.view(admin.clinicId, admin.now?.() ?? new Date()),
        );
        scope.put("/admin/setup/clinic", async (req, reply) => {
          await setup.saveClinic(admin.clinicId, req.body);
          return reply.code(204).send();
        });
        scope.post("/admin/setup/dentists", async (req, reply) =>
          reply.code(201).send(await setup.createDentist(admin.clinicId, req.body)),
        );
        scope.put<Id>("/admin/setup/dentists/:id", async (req, reply) => {
          await setup.updateDentist(admin.clinicId, req.params.id, req.body);
          return reply.code(204).send();
        });
        scope.put<Id>("/admin/setup/dentists/:id/hours", async (req, reply) => {
          await setup.setWorkingHours(admin.clinicId, req.params.id, req.body);
          return reply.code(204).send();
        });
        scope.post("/admin/setup/procedures", async (req, reply) =>
          reply.code(201).send(await setup.createProcedure(admin.clinicId, req.body)),
        );
        scope.put<Id>("/admin/setup/procedures/:id", async (req, reply) => {
          await setup.updateProcedure(admin.clinicId, req.params.id, req.body);
          return reply.code(204).send();
        });
        scope.post("/admin/setup/plans", async (req, reply) =>
          reply.code(201).send(await setup.createPlan(admin.clinicId, req.body)),
        );
        scope.put<Id>("/admin/setup/plans/:id", async (req, reply) => {
          await setup.updatePlan(admin.clinicId, req.params.id, req.body);
          return reply.code(204).send();
        });
        scope.put<Id>("/admin/setup/plans/:id/coverage", async (req, reply) => {
          await setup.setCoverage(admin.clinicId, req.params.id, req.body);
          return reply.code(204).send();
        });
        scope.post("/admin/setup/blocks", async (req, reply) =>
          reply.code(201).send(await setup.createBlock(admin.clinicId, req.body)),
        );
        scope.delete<Id>("/admin/setup/blocks/:id", async (req, reply) => {
          await setup.deleteBlock(admin.clinicId, req.params.id);
          return reply.code(204).send();
        });
      }
    });
  }

  if (deps.sandbox) {
    const sandbox = deps.sandbox;
    app.get("/dev/sandbox/outbox", async () => ({
      // Documents (quote PDFs) are listed by size; the bytes stay out of the JSON.
      messages: sandbox.outbox.map((m) =>
        m.kind === "document" ? { ...m, data: undefined, bytes: m.data.length } : m,
      ),
    }));
    app.delete("/dev/sandbox/outbox", async () => {
      sandbox.clear();
      return { cleared: true };
    });
  }

  return app;
}

class BadQueryError extends Error {}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
