import { describe, expect, it } from "vitest";
import {
  agendaHref,
  dentistsOf,
  filterAgenda,
  isFiltered,
  parseAgendaFilter,
} from "./agenda-filter";

const rows = [
  { id: "1", dentistName: "Dra. Ana", status: "CONFIRMED" },
  { id: "2", dentistName: "Dr. Beto", status: "PENDING_CONFIRMATION" },
  { id: "3", dentistName: "Dra. Ana", status: "NO_SHOW" },
  { id: "4", dentistName: "Dra. Ana", status: "CANCELLED" },
];

describe("parseAgendaFilter", () => {
  it("reads dentist and status, and ignores anything unknown", () => {
    expect(parseAgendaFilter({ dentista: " Dra. Ana ", situacao: "faltou" })).toEqual({
      dentist: "Dra. Ana",
      status: "faltou",
    });
    expect(parseAgendaFilter({ dentista: "", situacao: "toString" })).toEqual({
      dentist: null,
      status: null,
    });
    expect(isFiltered(parseAgendaFilter({}))).toBe(false);
  });
});

describe("filterAgenda", () => {
  it("keeps everything with no filter", () => {
    expect(filterAgenda(rows, { dentist: null, status: null })).toHaveLength(4);
  });

  it("filters by dentist, by status and by both", () => {
    expect(filterAgenda(rows, { dentist: "Dr. Beto", status: null }).map((r) => r.id)).toEqual([
      "2",
    ]);
    expect(filterAgenda(rows, { dentist: null, status: "a-confirmar" }).map((r) => r.id)).toEqual([
      "2",
    ]);
    expect(filterAgenda(rows, { dentist: "Dra. Ana", status: "faltou" }).map((r) => r.id)).toEqual([
      "3",
    ]);
    expect(filterAgenda(rows, { dentist: "Dr. Beto", status: "faltou" })).toEqual([]);
  });
});

describe("dentistsOf and agendaHref", () => {
  it("lists each dentist once, sorted", () => {
    expect(dentistsOf(rows)).toEqual(["Dr. Beto", "Dra. Ana"]);
  });

  it("keeps the filter when moving to another week", () => {
    expect(agendaHref("2026-10-27", { dentist: null, status: null })).toBe("/?de=2026-10-27");
    expect(agendaHref("2026-10-27", { dentist: "Dra. Ana", status: "faltou" })).toBe(
      "/?de=2026-10-27&dentista=Dra.+Ana&situacao=faltou",
    );
  });
});
