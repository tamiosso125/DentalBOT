import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { Logger } from "../lib/logger.js";
import type { FieldCipher } from "../privacy/index.js";
import { hashPassword, verifyPassword } from "./password.js";

/**
 * Personal panel logins for the clinic's staff. The dentist registers the front desk and can
 * deactivate whoever leaves; a deactivated login stops working on the next request. After
 * MAX_FAILURES wrong passwords in a row the login is locked for LOCK_MINUTES.
 */

export type StaffRole = "RECEPTION" | "DENTIST";
export type StaffActor = { id: string; name: string; role: StaffRole };
export type StaffRow = StaffActor & {
  email: string;
  active: boolean;
  lastLoginAt: string | null;
};

export const PASSWORD_MIN = 10;
export const MAX_FAILURES = 5;
export const LOCK_MINUTES = 15;

const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(120)
  .pipe(z.email({ message: "E-mail inválido." }));
const password = z
  .string()
  .min(PASSWORD_MIN, { message: `A senha precisa de pelo menos ${PASSWORD_MIN} caracteres.` })
  .max(200, { message: "Senha longa demais." });
const name = z
  .string()
  .trim()
  .min(2, { message: "Escreva o nome." })
  .max(80, { message: "Nome longo demais." });
const role = z.enum(["RECEPTION", "DENTIST"], { message: "Escolha a função." });

const newUserSchema = z.strictObject({ name, email, role, password });
const bootstrapSchema = z.strictObject({ name, email, password });
const loginSchema = z.object({ email: z.string().max(200), password: z.string().max(200) });
const activeSchema = z.strictObject({ active: z.boolean() });
const resetSchema = z.strictObject({ password });
const changeSchema = z.strictObject({ current: z.string().max(200), password });

export class StaffError extends Error {
  constructor(
    readonly status: 401 | 403 | 404 | 409 | 422 | 423,
    message: string,
  ) {
    super(message);
    this.name = "StaffError";
  }
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new StaffError(422, r.error.issues[0]?.message ?? "Dados inválidos.");
  return r.data;
}

const actorOf = (u: { id: string; name: string; role: StaffRole }): StaffActor => ({
  id: u.id,
  name: u.name,
  role: u.role,
});

export class StaffService {
  /** Compared against when the e-mail is unknown, so both paths take the same time. */
  private dummyHash: Promise<string> | undefined;

  constructor(private readonly deps: { db: PrismaClient; cipher: FieldCipher; logger: Logger }) {}

  async hasUsers(clinicId: string): Promise<boolean> {
    return (await this.deps.db.staffUser.count({ where: { clinicId } })) > 0;
  }

  /** First access: the dentist's own login, only while the clinic has no login at all. */
  async bootstrap(clinicId: string, input: unknown, now: Date): Promise<StaffActor> {
    const data = parse(bootstrapSchema, input);
    if (await this.hasUsers(clinicId))
      throw new StaffError(409, "O primeiro acesso já foi feito. Entre com o seu e-mail.");
    // On a fresh install the clinic row only exists after "Clínica" is filled in.
    await this.deps.db.clinic.upsert({
      where: { id: clinicId },
      create: { id: clinicId, name: "Minha clínica" },
      update: {},
    });
    const user = await this.insert(clinicId, { ...data, role: "DENTIST" }, now);
    // The panel signs her in right away.
    await this.deps.db.staffUser.update({ where: { id: user.id }, data: { lastLoginAt: now } });
    this.deps.logger.info({ clinicId, staffUserId: user.id }, "first staff login created");
    return user;
  }

  async login(clinicId: string, input: unknown, now: Date): Promise<StaffActor> {
    const wrong = new StaffError(401, "E-mail ou senha incorretos.");
    const r = loginSchema.safeParse(input);
    if (!r.success) throw wrong;
    const user = await this.deps.db.staffUser.findUnique({
      where: {
        clinicId_emailHash: { clinicId, emailHash: this.emailHash(r.data.email) },
      },
    });
    if (!user || !user.active) {
      await verifyPassword(r.data.password, await this.dummy());
      throw wrong;
    }
    if (user.lockedUntil && user.lockedUntil > now) throw this.locked(user.lockedUntil, now);
    if (!(await verifyPassword(r.data.password, user.passwordHash))) {
      const failures = user.failedLogins + 1;
      const lock = failures >= MAX_FAILURES;
      await this.deps.db.staffUser.update({
        where: { id: user.id },
        data: {
          failedLogins: lock ? 0 : failures,
          lockedUntil: lock ? new Date(now.getTime() + LOCK_MINUTES * 60_000) : user.lockedUntil,
        },
      });
      if (lock) {
        this.deps.logger.warn({ clinicId, staffUserId: user.id }, "staff login locked");
        throw this.locked(new Date(now.getTime() + LOCK_MINUTES * 60_000), now);
      }
      throw wrong;
    }
    await this.deps.db.staffUser.update({
      where: { id: user.id },
      data: { failedLogins: 0, lockedUntil: null, lastLoginAt: now },
    });
    return actorOf(user);
  }

  /** The signed-in person for a request, or null if unknown or deactivated. */
  async actor(clinicId: string, id: string): Promise<StaffActor | null> {
    const user = await this.deps.db.staffUser.findFirst({
      where: { id, clinicId, active: true },
      select: { id: true, name: true, role: true },
    });
    return user ? actorOf(user) : null;
  }

  async list(clinicId: string): Promise<StaffRow[]> {
    const users = await this.deps.db.staffUser.findMany({
      where: { clinicId },
      orderBy: [{ active: "desc" }, { name: "asc" }],
    });
    return users.map((u) => ({
      ...actorOf(u),
      email: this.deps.cipher.decrypt(u.emailEncrypted),
      active: u.active,
      lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
    }));
  }

  async create(clinicId: string, by: StaffActor, input: unknown, now: Date) {
    this.dentistOnly(by);
    const user = await this.insert(clinicId, parse(newUserSchema, input), now);
    this.deps.logger.info({ clinicId, staffUserId: user.id, by: by.id }, "staff login created");
    return { id: user.id };
  }

  async setActive(clinicId: string, by: StaffActor, id: string, input: unknown) {
    this.dentistOnly(by);
    const { active } = parse(activeSchema, input);
    const user = await this.find(clinicId, id);
    if (!active && user.role === "DENTIST") {
      const dentists = await this.deps.db.staffUser.count({
        where: { clinicId, role: "DENTIST", active: true },
      });
      if (dentists <= 1)
        throw new StaffError(409, "A clínica precisa de pelo menos um login de dentista ativo.");
    }
    await this.deps.db.staffUser.update({
      where: { id },
      data: { active, failedLogins: 0, lockedUntil: null },
    });
    this.deps.logger.info({ clinicId, staffUserId: id, by: by.id, active }, "staff login toggled");
  }

  /** The dentist sets a new password for someone who forgot theirs (also unlocks it). */
  async resetPassword(clinicId: string, by: StaffActor, id: string, input: unknown) {
    this.dentistOnly(by);
    const data = parse(resetSchema, input);
    await this.find(clinicId, id);
    await this.deps.db.staffUser.update({
      where: { id },
      data: { passwordHash: await hashPassword(data.password), failedLogins: 0, lockedUntil: null },
    });
    this.deps.logger.info({ clinicId, staffUserId: id, by: by.id }, "staff password reset");
  }

  /** Anyone changes their own password, knowing the current one. */
  async changeOwnPassword(clinicId: string, by: StaffActor, input: unknown) {
    const data = parse(changeSchema, input);
    const user = await this.find(clinicId, by.id);
    if (!(await verifyPassword(data.current, user.passwordHash)))
      throw new StaffError(422, "A senha atual não confere.");
    await this.deps.db.staffUser.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(data.password) },
    });
    this.deps.logger.info({ clinicId, staffUserId: user.id }, "staff password changed");
  }

  private async insert(
    clinicId: string,
    data: { name: string; email: string; role: StaffRole; password: string },
    now: Date,
  ): Promise<StaffActor> {
    try {
      const user = await this.deps.db.staffUser.create({
        data: {
          clinicId,
          name: data.name,
          role: data.role,
          emailHash: this.emailHash(data.email),
          emailEncrypted: this.deps.cipher.encrypt(data.email),
          passwordHash: await hashPassword(data.password),
          createdAt: now,
        },
      });
      return actorOf(user);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")
        throw new StaffError(409, "Já existe um login com esse e-mail.");
      throw err;
    }
  }

  private async find(clinicId: string, id: string) {
    const user = await this.deps.db.staffUser.findFirst({ where: { id, clinicId } });
    if (!user) throw new StaffError(404, "Login não encontrado.");
    return user;
  }

  private dentistOnly(by: StaffActor) {
    if (by.role !== "DENTIST") throw new StaffError(403, "Só a dentista cuida dos logins.");
  }

  private emailHash(value: string) {
    return this.deps.cipher.hash(value.trim().toLowerCase());
  }

  private locked(until: Date, now: Date) {
    const minutes = Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 60_000));
    return new StaffError(
      423,
      `Muitas tentativas erradas. Tente de novo em ${minutes} minuto${minutes > 1 ? "s" : ""}.`,
    );
  }

  private dummy() {
    this.dummyHash ??= hashPassword("not-a-real-password");
    return this.dummyHash;
  }
}
