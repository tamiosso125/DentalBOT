import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { Logger } from "../lib/logger.js";
import type { FieldCipher } from "../privacy/index.js";

/**
 * Staff notes on the patient record ("prefere manhã", "tem medo de agulha"). The text may
 * hold health information, so it is stored encrypted and never logged. Notes stay inside
 * the panel: neither the bot nor the LLM ever reads them.
 */

export const NOTE_MAX = 1000;

export const noteSchema = z.strictObject({
  author: z.enum(["RECEPTION", "DENTIST"]),
  text: z.string().trim().min(1).max(NOTE_MAX),
});

export type PatientNote = {
  id: string;
  author: "RECEPTION" | "DENTIST";
  text: string;
  createdAt: string;
  /** Who wrote it, when signed in with a personal login. */
  staffName: string | null;
};

export class PatientNoteError extends Error {
  constructor(
    readonly status: 404 | 422,
    message: string,
  ) {
    super(message);
    this.name = "PatientNoteError";
  }
}

export class PatientNotes {
  constructor(private readonly deps: { db: PrismaClient; cipher: FieldCipher; logger: Logger }) {}

  /** Newest first. */
  async list(clinicId: string, patientId: string): Promise<PatientNote[]> {
    const rows = await this.deps.db.patientNote.findMany({
      where: { clinicId, patientId },
      orderBy: { createdAt: "desc" },
      take: 200,
      include: { staffUser: { select: { name: true } } },
    });
    return rows.map((n) => ({
      id: n.id,
      author: n.author,
      text: this.deps.cipher.decrypt(n.textEncrypted),
      createdAt: n.createdAt.toISOString(),
      staffName: n.staffUser?.name ?? null,
    }));
  }

  async add(clinicId: string, patientId: string, input: unknown, now: Date, staffUserId?: string) {
    const r = noteSchema.safeParse(input);
    if (!r.success)
      throw new PatientNoteError(422, `Escreva a anotação (até ${NOTE_MAX} caracteres).`);
    const patient = await this.deps.db.patient.findFirst({
      where: { id: patientId, clinicId, anonymizedAt: null },
      select: { id: true },
    });
    if (!patient) throw new PatientNoteError(404, "Paciente não encontrado.");
    const note = await this.deps.db.patientNote.create({
      data: {
        clinicId,
        patientId,
        author: r.data.author,
        textEncrypted: this.deps.cipher.encrypt(r.data.text),
        staffUserId: staffUserId ?? null,
        createdAt: now,
      },
      select: { id: true },
    });
    this.deps.logger.info({ clinicId, patientId, noteId: note.id }, "patient note added");
    return { id: note.id };
  }

  async remove(clinicId: string, patientId: string, noteId: string) {
    const { count } = await this.deps.db.patientNote.deleteMany({
      where: { id: noteId, clinicId, patientId },
    });
    if (count === 0) throw new PatientNoteError(404, "Anotação não encontrada.");
    this.deps.logger.info({ clinicId, patientId, noteId }, "patient note removed");
  }
}
