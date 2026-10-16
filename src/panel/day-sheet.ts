import type { PrismaClient } from "@prisma/client";
import PDFDocument from "pdfkit";
import { z } from "zod";
import type { Logger } from "../lib/logger.js";
import type { FieldCipher } from "../privacy/index.js";
import { ddmmyyyy } from "../quotes/quote-pdf.js";
import { addDays, formatTimePtBr, zonedToUtc } from "../scheduling/time.js";
import { medicalAlerts, openMedicalHistory } from "./medical-history.js";

/**
 * Day sheet (agenda do dia): the day's appointments on paper, so the dentist can take them
 * to the chair. Name, time, procedure, plan and the medical alerts from the anamnesis; never
 * the phone number or the clinical notes. Handling is on the clinic: the sheet carries health
 * alerts, so every print is written to the access log.
 */

export const daySheetQuerySchema = z.strictObject({ day: z.iso.date() });

export type DaySheetRow = {
  from: string;
  to: string;
  patientName: string;
  procedureName: string;
  dentistName: string;
  /** Insurance plan name, or null for a private patient. */
  plan: string | null;
  status: string;
  alerts: string[];
};

export type DaySheetData = {
  clinicName: string;
  /** YYYY-MM-DD in the clinic's calendar. */
  day: string;
  rows: DaySheetRow[];
};

export class DaySheetError extends Error {
  constructor(
    readonly status: 404,
    message: string,
  ) {
    super(message);
    this.name = "DaySheetError";
  }
}

const STATUS_LABEL: Record<string, string> = {
  PENDING_CONFIRMATION: "A confirmar",
  CONFIRMED: "Confirmada",
  COMPLETED: "Compareceu",
  NO_SHOW: "Faltou",
};

const MARGIN = 40;

/** Renders the sheet as A4 PDF. Built-in Helvetica covers pt-BR accents. */
export function renderDaySheetPdf(
  d: DaySheetData,
  opts: { compress?: boolean } = {},
): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "A4",
    margin: MARGIN,
    compress: opts.compress ?? true,
    info: { Title: `Agenda do dia ${ddmmyyyy(d.day)} ${d.clinicName}`, Author: d.clinicName },
  });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const width = doc.page.width - MARGIN * 2;
  doc.font("Helvetica-Bold").fontSize(16).text(d.clinicName);
  doc
    .font("Helvetica")
    .fontSize(12)
    .text(`Agenda do dia ${ddmmyyyy(d.day)}`);
  doc
    .fontSize(9)
    .fillColor("#555")
    .text("Contém dados de saúde dos pacientes. Guarde com cuidado e descarte depois do uso.");
  doc.fillColor("#000").moveDown(0.8);

  if (d.rows.length === 0) {
    doc.fontSize(11).text("Nenhuma consulta neste dia.");
  }
  for (const r of d.rows) {
    const needed = r.alerts.length > 0 ? 54 : 40;
    if (doc.y + needed > doc.page.height - MARGIN) doc.addPage();
    const y = doc.y;
    doc.font("Helvetica-Bold").fontSize(11).text(`${r.from} - ${r.to}`, MARGIN, y, { width: 90 });
    doc.text(r.patientName, MARGIN + 95, y, { width: width - 95 - 90 });
    doc
      .font("Helvetica")
      .fontSize(9)
      .text(STATUS_LABEL[r.status] ?? r.status, MARGIN + width - 85, y + 1, {
        width: 85,
        align: "right",
      });
    const detail = [r.procedureName, r.dentistName, r.plan ?? "Particular"].join("  |  ");
    doc.fontSize(10).text(detail, MARGIN + 95, y + 15, { width: width - 95 });
    if (r.alerts.length > 0) {
      doc
        .font("Helvetica-Bold")
        .fillColor("#b00020")
        .text(`Atenção: ${r.alerts.join("; ")}`, MARGIN + 95, doc.y + 1, { width: width - 95 });
      doc.fillColor("#000");
    }
    const lineY = doc.y + 6;
    doc
      .moveTo(MARGIN, lineY)
      .lineTo(MARGIN + width, lineY)
      .strokeColor("#ccc")
      .stroke();
    doc.x = MARGIN;
    doc.y = lineY + 6;
  }

  doc.end();
  return done;
}

export class DaySheets {
  constructor(private readonly deps: { db: PrismaClient; cipher: FieldCipher; logger: Logger }) {}

  /** The PDF for one day of this clinic, cancelled appointments left out. */
  async pdf(clinicId: string, day: string): Promise<Buffer> {
    const data = await this.data(clinicId, day);
    const pdf = await renderDaySheetPdf(data);
    this.deps.logger.info({ clinicId, appointments: data.rows.length }, "day sheet issued");
    return pdf;
  }

  async data(clinicId: string, day: string): Promise<DaySheetData> {
    const clinic = await this.deps.db.clinic.findUnique({
      where: { id: clinicId },
      select: { name: true, timezone: true },
    });
    if (!clinic) throw new DaySheetError(404, "Clínica não encontrada.");
    const rows = await this.deps.db.appointment.findMany({
      where: {
        clinicId,
        status: { not: "CANCELLED" },
        startsAt: {
          gte: zonedToUtc(day, 0, clinic.timezone),
          lt: zonedToUtc(addDays(day, 1), 0, clinic.timezone),
        },
      },
      orderBy: { startsAt: "asc" },
      select: {
        status: true,
        startsAt: true,
        endsAt: true,
        patientId: true,
        patient: { select: { name: true, insurancePlan: { select: { name: true } } } },
        procedure: { select: { name: true } },
        dentist: { select: { name: true } },
      },
    });
    const alertsByPatient = await this.alerts(clinicId, [...new Set(rows.map((r) => r.patientId))]);
    return {
      clinicName: clinic.name,
      day: day,
      rows: rows.map((r) => ({
        from: formatTimePtBr(r.startsAt, clinic.timezone),
        to: formatTimePtBr(r.endsAt, clinic.timezone),
        patientName: r.patient.name,
        procedureName: r.procedure.name,
        dentistName: r.dentist.name,
        plan: r.patient.insurancePlan?.name ?? null,
        status: r.status,
        alerts: alertsByPatient.get(r.patientId) ?? [],
      })),
    };
  }

  /** Alerts from each patient's current anamnesis (the newest version). */
  private async alerts(clinicId: string, patientIds: string[]) {
    const out = new Map<string, string[]>();
    if (patientIds.length === 0) return out;
    const versions = await this.deps.db.medicalHistory.findMany({
      where: { clinicId, patientId: { in: patientIds } },
      orderBy: { createdAt: "desc" },
      select: { patientId: true, dataEncrypted: true },
    });
    for (const v of versions) {
      if (out.has(v.patientId)) continue;
      out.set(v.patientId, medicalAlerts(openMedicalHistory(this.deps.cipher, v.dataEncrypted)));
    }
    return out;
  }
}
