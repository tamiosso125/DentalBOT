import { describe, expect, it } from "vitest";
import {
  canWriteClinical,
  entryFromForm,
  parseTeeth,
  threadsByVisit,
  type ClinicalEntry,
} from "./clinical-record";

const entry = (id: string, over: Partial<ClinicalEntry> = {}): ClinicalEntry => ({
  id,
  at: "2026-10-20T13:00:00.000Z",
  appointmentId: "a1",
  appointmentAt: "2026-10-20T12:00:00.000Z",
  procedure: "Restauração",
  signedBy: "Dra. Ana",
  amendsId: null,
  data: { performed: "x", teeth: [], notes: null },
  ...over,
});

describe("clinical record helpers", () => {
  it("splits teeth on spaces, commas and semicolons, without repeats", () => {
    expect(parseTeeth("36, 37 46;36")).toEqual(["36", "37", "46"]);
    expect(parseTeeth("  ")).toEqual([]);
  });

  it("builds the body for a visit or for an addendum", () => {
    const f = new FormData();
    f.set("performed", "  Restauração ");
    f.set("teeth", "36 37");
    f.set("notes", " ");
    expect(entryFromForm(f, { appointmentId: "a1" })).toEqual({
      appointmentId: "a1",
      performed: "Restauração",
      teeth: ["36", "37"],
      notes: null,
    });
    expect(entryFromForm(f, { amendsId: "e1" })).toMatchObject({ amendsId: "e1" });
  });

  it("lets only a dentist write", () => {
    expect(canWriteClinical({ role: "DENTIST" })).toBe(true);
    expect(canWriteClinical({ role: "RECEPTION" })).toBe(false);
    expect(canWriteClinical(null)).toBe(false);
  });

  it("groups by visit, newest first, with addenda under their entry", () => {
    const entries = [
      entry("e1"),
      entry("e2", { appointmentId: "a2", appointmentAt: "2026-10-27T12:00:00.000Z" }),
      entry("e3", { amendsId: "e1" }),
      entry("e4", { amendsId: "e3" }),
    ];
    const visits = threadsByVisit(entries);
    expect(visits.map((v) => v.appointmentId)).toEqual(["a2", "a1"]);
    expect(visits[1]!.threads).toHaveLength(1);
    expect(visits[1]!.threads[0]!.addenda.map((a) => a.id)).toEqual(["e3", "e4"]);
  });
});
