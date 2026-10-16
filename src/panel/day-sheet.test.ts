import { describe, expect, it } from "vitest";
import { renderDaySheetPdf, type DaySheetData } from "./day-sheet.js";

const row = {
  from: "09:00",
  to: "09:30",
  patientName: "Maria Silva",
  procedureName: "Limpeza",
  dentistName: "Dra. Ana Exemplo",
  plan: null,
  status: "CONFIRMED",
  alerts: [],
};
const data: DaySheetData = { clinicName: "Clínica Sorriso", day: "2026-10-20", rows: [row] };

const pages = (pdf: Buffer) => pdf.toString("latin1").match(/\/Type \/Page\b/g)?.length ?? 0;

describe("day sheet", () => {
  it("renders a PDF for a day with alerts, a plan and no appointments", async () => {
    const pdf = await renderDaySheetPdf(
      {
        ...data,
        rows: [{ ...row, plan: "Odontoprev", alerts: ["Alergia: penicilina", "Gestante"] }],
      },
      { compress: false },
    );
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.subarray(-6).toString()).toContain("%%EOF");
    expect(pages(pdf)).toBe(1);
    const empty = await renderDaySheetPdf({ ...data, rows: [] }, { compress: false });
    expect(empty.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("breaks a long day over more pages", async () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ ...row, patientName: `Paciente ${i}` }));
    const pdf = await renderDaySheetPdf({ ...data, rows }, { compress: false });
    expect(pages(pdf)).toBeGreaterThan(1);
  });
});
