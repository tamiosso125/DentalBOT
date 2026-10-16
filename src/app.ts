import { PrismaClient } from "@prisma/client";
import { AnthropicLlm } from "./ai/llm.js";
import type { OrchestratorDeps } from "./ai/orchestrator.js";
import type { Env } from "./config/env.js";
import { handleWhatsAppEvent } from "./conversation/handler.js";
import { PrismaConversationStore } from "./conversation/prisma-store.js";
import { buildServer } from "./http/server.js";
import type { Logger } from "./lib/logger.js";
import {
  ASAAS_BASE_URL,
  AsaasHttpGateway,
  MockPaymentsGateway,
  type AsaasWebhookEvent,
  type PaymentsGateway,
} from "./payments/asaas.js";
import {
  InstallmentReminders,
  PrismaReminderRepository,
} from "./payments/installment-reminders.js";
import { OverdueNotices, PrismaOverdueNoticeRepository } from "./payments/overdue-notices.js";
import { handleAsaasEvent, PrismaPaymentEventStore } from "./payments/payment-events.js";
import { PrismaPanelQueries } from "./panel/panel-queries.js";
import { PrismaBilling } from "./panel/billing.js";
import { PrismaMonthlyReports } from "./panel/monthly-report.js";
import { PrismaPatientRecords } from "./panel/patient-record.js";
import { PatientNotes } from "./panel/patient-notes.js";
import { AccessLog } from "./panel/access-log.js";
import { ClinicPayments } from "./payments/clinic-payments.js";
import { PrismaClinicSetup } from "./panel/clinic-setup.js";
import { PrismaPatientData } from "./panel/patient-data.js";
import { FieldCipher } from "./privacy/index.js";
import { PrismaQuoteRepository } from "./quotes/prisma-quotes.js";
import { QuoteBillingService } from "./quotes/quote-billing.js";
import { QuoteFollowUps } from "./quotes/quote-follow-up.js";
import { QuoteService } from "./quotes/quote-service.js";
import { PrismaRecallRepository } from "./recall/prisma-recall.js";
import { RecallService } from "./recall/recall.js";
import { NoShowFollowUps, PrismaNoShowFollowUpRepository } from "./scheduling/no-show-follow-up.js";
import { InsuranceAuthorizations } from "./insurance/authorizations.js";
import { PrismaInsuranceRepository } from "./insurance/prisma-insurance.js";
import { PrismaSurveyRepository } from "./survey/prisma-survey.js";
import { AftercareService } from "./aftercare/aftercare.js";
import { PrismaAftercareRepository } from "./aftercare/prisma-aftercare.js";
import { SurveyService } from "./survey/survey.js";
import { PrismaWaitlistRepository } from "./waitlist/prisma-waitlist.js";
import { WaitlistService } from "./waitlist/waitlist.js";
import { BullQueue, InMemoryQueue, type JobHandler, type JobQueue } from "./queue/queue.js";
import {
  AppointmentReminders,
  PrismaAppointmentReminderRepository,
} from "./scheduling/appointment-reminders.js";
import { prismaAgendaFor } from "./scheduling/prisma-agenda.js";
import { prismaStaffAgendaOpener, StaffAgenda } from "./scheduling/staff-agenda.js";
import {
  CloudApiChannel,
  SandboxChannel,
  type WhatsAppChannel,
  type WhatsAppEvent,
} from "./whatsapp/index.js";

/** Wires real dependencies from the environment. Tests build their own graph instead. */
export function createApp(env: Env, logger: Logger) {
  const db = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
  const cipher = new FieldCipher(env.PII_ENCRYPTION_KEY, env.PII_HASH_SECRET);

  const sandbox = env.WHATSAPP_MODE === "sandbox" ? new SandboxChannel() : undefined;
  const channel: WhatsAppChannel =
    sandbox ??
    new CloudApiChannel({
      accessToken: env.WHATSAPP_ACCESS_TOKEN!,
      phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID!,
      graphApiVersion: env.WHATSAPP_GRAPH_API_VERSION,
    });

  const payments: PaymentsGateway =
    env.ASAAS_ENV === "mock"
      ? new MockPaymentsGateway()
      : new AsaasHttpGateway(env.ASAAS_API_KEY!, ASAAS_BASE_URL[env.ASAAS_ENV]);

  const conversationStore = new PrismaConversationStore(db, cipher, env.DEFAULT_CLINIC_ID);
  const paymentStore = new PrismaPaymentEventStore(db);

  const quoteRepo = new PrismaQuoteRepository(db, cipher);
  const quotes = new QuoteService({
    repo: quoteRepo,
    channel,
    store: conversationStore,
    logger,
    billing: new QuoteBillingService({ repo: quoteRepo, gateway: payments, logger }),
  });

  const quoteFollowUps = new QuoteFollowUps({
    repo: quoteRepo,
    channel,
    store: conversationStore,
    logger,
    config: { remindAfterDays: env.QUOTE_REMINDER_DAYS },
  });
  const runQuoteFollowUps = () =>
    quoteFollowUps
      .run(new Date())
      .catch((err: unknown) =>
        logger.error(
          { err: err instanceof Error ? err.message : "unknown" },
          "quote follow-ups run failed",
        ),
      );
  const quoteFollowUpTimer =
    env.QUOTE_FOLLOW_UP_INTERVAL_MINUTES > 0
      ? setInterval(runQuoteFollowUps, env.QUOTE_FOLLOW_UP_INTERVAL_MINUTES * 60_000)
      : undefined;
  quoteFollowUpTimer?.unref();

  const reminders = new InstallmentReminders({
    repo: new PrismaReminderRepository(db, cipher),
    gateway: payments,
    channel,
    store: conversationStore,
    logger,
    config: { daysBefore: env.INSTALLMENT_REMINDER_DAYS },
  });
  const overdueNotices = new OverdueNotices({
    repo: new PrismaOverdueNoticeRepository(db, cipher),
    gateway: payments,
    channel,
    store: conversationStore,
    logger,
    config: { daysAfter: env.OVERDUE_NOTICE_DAYS },
  });
  const runReminders = () =>
    reminders
      .run(new Date())
      .then(() => overdueNotices.run(new Date()))
      .catch((err: unknown) =>
        logger.error(
          { err: err instanceof Error ? err.message : "unknown" },
          "reminders run failed",
        ),
      );
  // In-process timer: every run is idempotent, so several instances are safe.
  const reminderTimer =
    env.INSTALLMENT_REMINDER_INTERVAL_MINUTES > 0
      ? setInterval(runReminders, env.INSTALLMENT_REMINDER_INTERVAL_MINUTES * 60_000)
      : undefined;
  reminderTimer?.unref();

  const appointmentReminders = new AppointmentReminders({
    repo: new PrismaAppointmentReminderRepository(db, cipher),
    channel,
    store: conversationStore,
    logger,
  });
  const noShowFollowUps = new NoShowFollowUps({
    repo: new PrismaNoShowFollowUpRepository(db, cipher),
    channel,
    store: conversationStore,
    logger,
  });
  // The "we missed you" message after a no-show runs on the same timer.
  const runAppointmentReminders = () =>
    appointmentReminders
      .run(new Date())
      .then(() => noShowFollowUps.run(new Date()))
      .catch((err: unknown) =>
        logger.error(
          { err: err instanceof Error ? err.message : "unknown" },
          "appointment reminders run failed",
        ),
      );
  const appointmentReminderTimer =
    env.APPOINTMENT_REMINDER_INTERVAL_MINUTES > 0
      ? setInterval(runAppointmentReminders, env.APPOINTMENT_REMINDER_INTERVAL_MINUTES * 60_000)
      : undefined;
  appointmentReminderTimer?.unref();

  const recallRepo = new PrismaRecallRepository(db, cipher);
  const recall = new RecallService({
    repo: recallRepo,
    channel,
    store: conversationStore,
    logger,
    config: { afterMonths: env.RECALL_AFTER_MONTHS },
  });
  const runRecall = () =>
    recall
      .run(new Date())
      .catch((err: unknown) =>
        logger.error({ err: err instanceof Error ? err.message : "unknown" }, "recall run failed"),
      );
  const recallTimer =
    env.RECALL_INTERVAL_MINUTES > 0
      ? setInterval(runRecall, env.RECALL_INTERVAL_MINUTES * 60_000)
      : undefined;
  recallTimer?.unref();

  const waitlist = new WaitlistService({
    repo: new PrismaWaitlistRepository(db, cipher),
    agendaFor: (clinicId) => prismaAgendaFor(db, cipher, clinicId),
    channel,
    store: conversationStore,
    logger,
  });
  const runWaitlist = () =>
    waitlist
      .run(new Date())
      .catch((err: unknown) =>
        logger.error(
          { err: err instanceof Error ? err.message : "unknown" },
          "waitlist run failed",
        ),
      );
  const waitlistTimer =
    env.WAITLIST_INTERVAL_MINUTES > 0
      ? setInterval(runWaitlist, env.WAITLIST_INTERVAL_MINUTES * 60_000)
      : undefined;
  waitlistTimer?.unref();

  const insurance = new InsuranceAuthorizations({
    repo: new PrismaInsuranceRepository(db, cipher),
    channel,
    store: conversationStore,
    logger,
  });

  const survey = new SurveyService({
    repo: new PrismaSurveyRepository(db, cipher),
    channel,
    store: conversationStore,
    logger,
  });
  const runSurvey = () =>
    survey
      .run(new Date())
      .catch((err: unknown) =>
        logger.error({ err: err instanceof Error ? err.message : "unknown" }, "survey run failed"),
      );
  const surveyTimer =
    env.SURVEY_INTERVAL_MINUTES > 0
      ? setInterval(runSurvey, env.SURVEY_INTERVAL_MINUTES * 60_000)
      : undefined;
  surveyTimer?.unref();

  const aftercare = new AftercareService({
    repo: new PrismaAftercareRepository(db, cipher),
    channel,
    store: conversationStore,
    logger,
  });
  const runAftercare = () =>
    aftercare
      .run(new Date())
      .catch((err: unknown) =>
        logger.error(
          { err: err instanceof Error ? err.message : "unknown" },
          "aftercare run failed",
        ),
      );
  const aftercareTimer =
    env.AFTERCARE_INTERVAL_MINUTES > 0
      ? setInterval(runAftercare, env.AFTERCARE_INTERVAL_MINUTES * 60_000)
      : undefined;
  aftercareTimer?.unref();

  const accessLog = new AccessLog({ db, logger });
  const purgeAccessLog = () =>
    accessLog
      .purge(env.ACCESS_LOG_RETENTION_DAYS, new Date())
      .catch((err: unknown) =>
        logger.error(
          { err: err instanceof Error ? err.message : "unknown" },
          "access log purge failed",
        ),
      );
  const accessLogTimer = setInterval(purgeAccessLog, 24 * 60 * 60_000);
  accessLogTimer.unref();
  void purgeAccessLog();

  const ai: OrchestratorDeps | undefined =
    env.AI_MODE === "anthropic"
      ? {
          llm: new AnthropicLlm(env.ANTHROPIC_API_KEY),
          store: conversationStore,
          agendaFor: (clinicId) => prismaAgendaFor(db, cipher, clinicId),
          logger,
          effort: env.AI_ATTENDANT_EFFORT,
          waitlist,
          insurance,
        }
      : undefined;

  const makeQueue = <T>(name: string, handler: JobHandler<T>): JobQueue<T> =>
    env.QUEUE_MODE === "redis"
      ? new BullQueue<T>(name, env.REDIS_URL, handler, logger)
      : new InMemoryQueue<T>(handler, logger);

  const whatsappQueue = makeQueue<WhatsAppEvent>("whatsapp-events", (event) =>
    handleWhatsAppEvent(event, {
      store: conversationStore,
      channel,
      logger,
      ai,
      quotes,
      agendaFor: (clinicId) => prismaAgendaFor(db, cipher, clinicId),
      recall: recallRepo,
      waitlist,
      survey,
      aftercare,
      insurance,
      config: {
        handoffPauseMinutes: env.HANDOFF_PAUSE_MINUTES,
        privacyPolicyUrl: env.PRIVACY_POLICY_URL,
      },
    }),
  );
  const asaasQueue = makeQueue<AsaasWebhookEvent>("asaas-events", (event) =>
    handleAsaasEvent(event, { store: paymentStore, logger }),
  );

  const server = buildServer({
    logger,
    whatsappQueue,
    asaasQueue,
    config: {
      whatsappVerifyToken: env.WHATSAPP_VERIFY_TOKEN,
      whatsappAppSecret: env.WHATSAPP_APP_SECRET,
      asaasWebhookToken: env.ASAAS_WEBHOOK_TOKEN,
    },
    sandbox: env.NODE_ENV !== "production" ? sandbox : undefined,
    admin:
      env.ADMIN_API_TOKEN && env.DEFAULT_CLINIC_ID
        ? {
            token: env.ADMIN_API_TOKEN,
            clinicId: env.DEFAULT_CLINIC_ID,
            quotes,
            panel: new PrismaPanelQueries(db, cipher),
            agenda: new StaffAgenda({
              open: prismaStaffAgendaOpener(db, cipher),
              channel,
              store: conversationStore,
              logger,
            }),
            patientData: new PrismaPatientData(db, cipher),
            setup: new PrismaClinicSetup(db, logger),
            billing: new PrismaBilling(db, cipher, payments),
            report: new PrismaMonthlyReports(db),
            records: new PrismaPatientRecords(db, cipher),
            notes: new PatientNotes({ db, cipher, logger }),
            accessLog,
            clinicPayments: new ClinicPayments({ db, cipher, gateway: payments, logger }),
            recall,
            waitlist,
            survey,
            aftercare,
            insurance,
          }
        : undefined,
  });

  async function close() {
    if (reminderTimer) clearInterval(reminderTimer);
    if (appointmentReminderTimer) clearInterval(appointmentReminderTimer);
    if (recallTimer) clearInterval(recallTimer);
    if (waitlistTimer) clearInterval(waitlistTimer);
    if (surveyTimer) clearInterval(surveyTimer);
    if (aftercareTimer) clearInterval(aftercareTimer);
    clearInterval(accessLogTimer);
    if (quoteFollowUpTimer) clearInterval(quoteFollowUpTimer);
    await server.close();
    await whatsappQueue.close();
    await asaasQueue.close();
    await db.$disconnect();
  }

  return {
    server,
    db,
    channel,
    payments,
    reminders,
    appointmentReminders,
    recall,
    waitlist,
    survey,
    aftercare,
    close,
  };
}
