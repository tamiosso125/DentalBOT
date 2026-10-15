import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { Logger } from "../lib/logger.js";
import { addDays, zonedToUtc } from "../scheduling/time.js";

/**
 * Clinic registration from the staff panel: clinic data, dentists and their working hours,
 * procedures with private prices, insurance plans with the procedures they cover, and
 * schedule blocks (vacations, holidays). Everything the bot offers (procedures, prices,
 * coverage, free slots) comes from here. Scoped to one clinic.
 */

export type WorkingWindowInput = { weekday: number; startMinute: number; endMinute: number };

export type SetupView = {
  /** Null until the clinic data is saved for the first time. */
  clinic: { name: string; address: string | null; timeZone: string } | null;
  dentists: Array<{
    id: string;
    name: string;
    cro: string | null;
    active: boolean;
    workingHours: WorkingWindowInput[];
  }>;
  procedures: Array<{
    id: string;
    name: string;
    durationMinutes: number;
    priceCents: number | null;
    active: boolean;
  }>;
  /** Accepted plans and the procedures each covers. No rows = coverage not registered yet. */
  insurancePlans: Array<{
    id: string;
    name: string;
    coverage: Array<{ procedureId: string; requiresAuthorization: boolean }>;
  }>;
  /** Blocks that have not ended yet, soonest first. */
  blocks: Array<{
    id: string;
    dentistId: string;
    dentistName: string;
    startsAt: string;
    endsAt: string;
    reason: string | null;
  }>;
};

/** A request the front desk can fix (shown in the panel). `status` is the HTTP code. */
export class ClinicSetupError extends Error {
  constructor(
    readonly status: 404 | 409 | 422,
    message: string,
  ) {
    super(message);
    this.name = "ClinicSetupError";
  }
}

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

export const clinicSchema = z.strictObject({
  name: z.string().trim().min(2).max(120),
  address: optionalText(200),
});

export const dentistSchema = z.strictObject({
  name: z.string().trim().min(3).max(120),
  cro: optionalText(30),
  active: z.boolean().default(true),
});

const minute = z
  .number()
  .int()
  .min(0)
  .max(24 * 60);

export const hoursSchema = z.strictObject({
  hours: z
    .array(
      z.strictObject({
        weekday: z.number().int().min(0).max(6),
        startMinute: minute.refine((m) => m % 5 === 0),
        endMinute: minute.refine((m) => m % 5 === 0),
      }),
    )
    .max(21),
});

export const procedureSchema = z.strictObject({
  name: z.string().trim().min(2).max(80),
  durationMinutes: z
    .number()
    .int()
    .min(5)
    .max(8 * 60)
    .refine((m) => m % 5 === 0),
  /** Private price in cents; null = price only after evaluation. */
  priceCents: z.number().int().min(0).max(10_000_000).nullable(),
  active: z.boolean().default(true),
});

export const planSchema = z.strictObject({ name: z.string().trim().min(2).max(60) });

/** The procedures the plan covers; any procedure left out is not covered. */
export const coverageSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        procedureId: z.string().min(1).max(64),
        requiresAuthorization: z.boolean().default(false),
      }),
    )
    .max(300)
    .refine((items) => new Set(items.map((i) => i.procedureId)).size === items.length),
});

/**
 * Dates are clinic-local. Without minutes the block covers whole days, `toDate` included.
 * With minutes it runs from `fromDate fromMinute` to `toDate toMinute`.
 */
export const blockSchema = z
  .strictObject({
    dentistId: z.string().min(1).max(64),
    fromDate: z.iso.date(),
    toDate: z.iso.date(),
    fromMinute: minute.optional(),
    toMinute: minute.optional(),
    reason: optionalText(120),
  })
  .refine((b) => (b.fromMinute === undefined) === (b.toMinute === undefined));

const WEEKDAYS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

/** Sorts the windows and rejects empty or overlapping ones, with a message for the panel. */
export function checkWorkingHours(hours: WorkingWindowInput[]): WorkingWindowInput[] {
  const sorted = [...hours].sort((a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute);
  for (const [i, w] of sorted.entries()) {
    if (w.endMinute <= w.startMinute)
      throw new ClinicSetupError(
        422,
        `O horário de ${WEEKDAYS[w.weekday]} termina antes de começar.`,
      );
    const prev = sorted[i - 1];
    if (prev && prev.weekday === w.weekday && prev.endMinute > w.startMinute)
      throw new ClinicSetupError(422, `Os horários de ${WEEKDAYS[w.weekday]} se sobrepõem.`);
  }
  return sorted;
}

/** UTC range of a block, in the clinic timezone. */
export function blockRange(b: z.infer<typeof blockSchema>, timeZone: string) {
  const startsAt = zonedToUtc(b.fromDate, b.fromMinute ?? 0, timeZone);
  const endsAt =
    b.toMinute === undefined
      ? zonedToUtc(addDays(b.toDate, 1), 0, timeZone)
      : zonedToUtc(b.toDate, b.toMinute, timeZone);
  if (endsAt <= startsAt) throw new ClinicSetupError(422, "O bloqueio termina antes de começar.");
  if (endsAt.getTime() - startsAt.getTime() > 366 * 24 * 60 * 60_000)
    throw new ClinicSetupError(422, "O bloqueio pode durar no máximo um ano.");
  return { startsAt, endsAt };
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new ClinicSetupError(422, "Dados inválidos.");
  return r.data;
}

const NO_CLINIC = "Cadastre primeiro os dados da clínica.";

export interface ClinicSetup {
  view(clinicId: string, now: Date): Promise<SetupView>;
  /** Creates the clinic on the first save: a new install only needs DEFAULT_CLINIC_ID set. */
  saveClinic(clinicId: string, input: unknown): Promise<void>;
  createDentist(clinicId: string, input: unknown): Promise<{ id: string }>;
  updateDentist(clinicId: string, id: string, input: unknown): Promise<void>;
  /** Replaces all the dentist's working hours. */
  setWorkingHours(clinicId: string, dentistId: string, input: unknown): Promise<void>;
  createProcedure(clinicId: string, input: unknown): Promise<{ id: string }>;
  updateProcedure(clinicId: string, id: string, input: unknown): Promise<void>;
  /** `appointments`: active appointments inside the block, left for the front desk to move. */
  createPlan(clinicId: string, input: unknown): Promise<{ id: string }>;
  updatePlan(clinicId: string, id: string, input: unknown): Promise<void>;
  /** Replaces the plan's coverage table. */
  setCoverage(clinicId: string, planId: string, input: unknown): Promise<void>;
  createBlock(clinicId: string, input: unknown): Promise<{ id: string; appointments: number }>;
  deleteBlock(clinicId: string, id: string): Promise<void>;
}

export class PrismaClinicSetup implements ClinicSetup {
  constructor(
    private readonly db: PrismaClient,
    private readonly logger: Logger,
  ) {}

  async view(clinicId: string, now: Date): Promise<SetupView> {
    const [clinic, dentists, procedures, plans, blocks] = await Promise.all([
      this.db.clinic.findUnique({ where: { id: clinicId } }),
      this.db.dentist.findMany({
        where: { clinicId },
        orderBy: { createdAt: "asc" },
        include: { workingHours: { orderBy: [{ weekday: "asc" }, { startMinute: "asc" }] } },
      }),
      this.db.procedure.findMany({ where: { clinicId }, orderBy: { name: "asc" } }),
      this.db.insurancePlan.findMany({
        where: { clinicId },
        orderBy: { name: "asc" },
        include: {
          coverages: {
            where: { covered: true },
            select: { procedureId: true, requiresAuthorization: true },
          },
        },
      }),
      this.db.scheduleBlock.findMany({
        where: { dentist: { clinicId }, endsAt: { gt: now } },
        orderBy: { startsAt: "asc" },
        take: 100,
        include: { dentist: { select: { name: true } } },
      }),
    ]);
    return {
      clinic: clinic
        ? { name: clinic.name, address: clinic.address, timeZone: clinic.timezone }
        : null,
      dentists: dentists.map((d) => ({
        id: d.id,
        name: d.name,
        cro: d.cro,
        active: d.active,
        workingHours: d.workingHours.map(({ weekday, startMinute, endMinute }) => ({
          weekday,
          startMinute,
          endMinute,
        })),
      })),
      procedures: procedures.map((p) => ({
        id: p.id,
        name: p.name,
        durationMinutes: p.durationMinutes,
        priceCents: p.priceCents,
        active: p.active,
      })),
      insurancePlans: plans.map((p) => ({ id: p.id, name: p.name, coverage: p.coverages })),
      blocks: blocks.map((b) => ({
        id: b.id,
        dentistId: b.dentistId,
        dentistName: b.dentist.name,
        startsAt: b.startsAt.toISOString(),
        endsAt: b.endsAt.toISOString(),
        reason: b.reason,
      })),
    };
  }

  async saveClinic(clinicId: string, input: unknown) {
    const data = parse(clinicSchema, input);
    await this.db.clinic.upsert({
      where: { id: clinicId },
      create: { id: clinicId, ...data },
      update: data,
    });
    this.logger.info({ clinicId }, "clinic data saved");
  }

  async createDentist(clinicId: string, input: unknown) {
    const data = parse(dentistSchema, input);
    await this.clinic(clinicId);
    const { id } = await this.db.dentist.create({ data: { clinicId, ...data } });
    this.logger.info({ clinicId, dentistId: id }, "dentist created");
    return { id };
  }

  async updateDentist(clinicId: string, id: string, input: unknown) {
    const data = parse(dentistSchema, input);
    const { count } = await this.db.dentist.updateMany({ where: { id, clinicId }, data });
    if (count === 0) throw new ClinicSetupError(404, "Dentista não encontrado.");
    this.logger.info({ clinicId, dentistId: id }, "dentist updated");
  }

  async setWorkingHours(clinicId: string, dentistId: string, input: unknown) {
    const hours = checkWorkingHours(parse(hoursSchema, input).hours);
    await this.dentist(clinicId, dentistId);
    await this.db.$transaction([
      this.db.workingHours.deleteMany({ where: { dentistId } }),
      this.db.workingHours.createMany({ data: hours.map((h) => ({ dentistId, ...h })) }),
    ]);
    this.logger.info({ clinicId, dentistId, windows: hours.length }, "working hours saved");
  }

  async createProcedure(clinicId: string, input: unknown) {
    const data = parse(procedureSchema, input);
    await this.clinic(clinicId);
    const { id } = await uniqueName(() =>
      this.db.procedure.create({ data: { clinicId, ...data } }),
    );
    this.logger.info({ clinicId, procedureId: id }, "procedure created");
    return { id };
  }

  async updateProcedure(clinicId: string, id: string, input: unknown) {
    const data = parse(procedureSchema, input);
    const { count } = await uniqueName(() =>
      this.db.procedure.updateMany({ where: { id, clinicId }, data }),
    );
    if (count === 0) throw new ClinicSetupError(404, "Procedimento não encontrado.");
    this.logger.info({ clinicId, procedureId: id }, "procedure updated");
  }

  async createPlan(clinicId: string, input: unknown) {
    const data = parse(planSchema, input);
    await this.clinic(clinicId);
    const { id } = await uniqueName(
      () => this.db.insurancePlan.create({ data: { clinicId, ...data } }),
      "Já existe um convênio com esse nome.",
    );
    this.logger.info({ clinicId, planId: id }, "insurance plan created");
    return { id };
  }

  async updatePlan(clinicId: string, id: string, input: unknown) {
    const data = parse(planSchema, input);
    const { count } = await uniqueName(
      () => this.db.insurancePlan.updateMany({ where: { id, clinicId }, data }),
      "Já existe um convênio com esse nome.",
    );
    if (count === 0) throw new ClinicSetupError(404, "Convênio não encontrado.");
    this.logger.info({ clinicId, planId: id }, "insurance plan updated");
  }

  async setCoverage(clinicId: string, planId: string, input: unknown) {
    const { items } = parse(coverageSchema, input);
    const plan = await this.db.insurancePlan.findFirst({ where: { id: planId, clinicId } });
    if (!plan) throw new ClinicSetupError(404, "Convênio não encontrado.");
    const ids = items.map((i) => i.procedureId);
    const known = await this.db.procedure.count({ where: { clinicId, id: { in: ids } } });
    if (known !== ids.length) throw new ClinicSetupError(422, "Procedimento não encontrado.");
    await this.db.$transaction([
      this.db.insuranceCoverage.deleteMany({ where: { insurancePlanId: planId } }),
      this.db.insuranceCoverage.createMany({
        data: items.map((i) => ({ insurancePlanId: planId, covered: true, ...i })),
      }),
    ]);
    this.logger.info({ clinicId, planId, procedures: items.length }, "insurance coverage saved");
  }

  async createBlock(clinicId: string, input: unknown) {
    const data = parse(blockSchema, input);
    const { timezone } = await this.clinic(clinicId);
    const { startsAt, endsAt } = blockRange(data, timezone);
    await this.dentist(clinicId, data.dentistId);
    const block = await this.db.scheduleBlock.create({
      data: { dentistId: data.dentistId, startsAt, endsAt, reason: data.reason },
    });
    const appointments = await this.db.appointment.count({
      where: {
        clinicId,
        dentistId: data.dentistId,
        status: { not: "CANCELLED" },
        startsAt: { lt: endsAt },
        endsAt: { gt: startsAt },
      },
    });
    this.logger.info({ clinicId, blockId: block.id, appointments }, "schedule block created");
    return { id: block.id, appointments };
  }

  async deleteBlock(clinicId: string, id: string) {
    const { count } = await this.db.scheduleBlock.deleteMany({
      where: { id, dentist: { clinicId } },
    });
    if (count === 0) throw new ClinicSetupError(404, "Bloqueio não encontrado.");
    this.logger.info({ clinicId, blockId: id }, "schedule block deleted");
  }

  private async clinic(clinicId: string) {
    const clinic = await this.db.clinic.findUnique({ where: { id: clinicId } });
    if (!clinic) throw new ClinicSetupError(409, NO_CLINIC);
    return clinic;
  }

  private async dentist(clinicId: string, id: string) {
    const dentist = await this.db.dentist.findFirst({ where: { id, clinicId } });
    if (!dentist) throw new ClinicSetupError(404, "Dentista não encontrado.");
    return dentist;
  }
}

async function uniqueName<T>(
  fn: () => Promise<T>,
  message = "Já existe um procedimento com esse nome.",
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")
      throw new ClinicSetupError(409, message);
    throw err;
  }
}
