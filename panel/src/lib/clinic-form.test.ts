import { describe, expect, it } from "vitest";
import {
  describeBlock,
  describeHours,
  formatClock,
  hourField,
  parseBlockForm,
  parseClinicForm,
  parseClock,
  parseDentistForm,
  parseHoursForm,
  parseProcedureForm,
  priceInput,
  rangesOf,
  setupGaps,
  type SetupView,
} from "./clinic-form";

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

describe("clock helpers", () => {
  it("converts between HH:MM and minutes", () => {
    expect(parseClock("08:30")).toBe(510);
    expect(parseClock("24:00")).toBeNull();
    expect(parseClock("8:30")).toBeNull();
    expect(formatClock(510)).toBe("08:30");
    expect(formatClock(1080)).toBe("18:00");
  });
});

describe("parseClinicForm / parseDentistForm", () => {
  it("requires a name and turns empty optional fields into null", () => {
    expect(parseClinicForm(form({ name: " Clínica Sorriso ", address: "" }))).toEqual({
      body: { name: "Clínica Sorriso", address: null },
    });
    expect(parseClinicForm(form({ name: "" }))).toEqual({
      errors: ["Informe o nome da clínica."],
    });
    expect(parseDentistForm(form({ name: "Dra. Ana", cro: "" }))).toEqual({
      body: { name: "Dra. Ana", cro: null, active: true },
    });
  });

  it("reads the active checkbox only on edit forms", () => {
    expect(parseDentistForm(form({ name: "Dra. Ana", activeField: "1" }))).toMatchObject({
      body: { active: false },
    });
    expect(
      parseDentistForm(form({ name: "Dra. Ana", activeField: "1", active: "on" })),
    ).toMatchObject({ body: { active: true } });
  });
});

describe("parseHoursForm", () => {
  it("turns morning and afternoon ranges into working windows", () => {
    const f = form({
      [hourField(1, 0, "start")]: "08:00",
      [hourField(1, 0, "end")]: "12:00",
      [hourField(1, 1, "start")]: "13:00",
      [hourField(1, 1, "end")]: "18:00",
      [hourField(6, 0, "start")]: "08:00",
      [hourField(6, 0, "end")]: "12:00",
    });
    expect(parseHoursForm(f)).toEqual({
      body: {
        hours: [
          { weekday: 1, startMinute: 480, endMinute: 720 },
          { weekday: 1, startMinute: 780, endMinute: 1080 },
          { weekday: 6, startMinute: 480, endMinute: 720 },
        ],
      },
    });
    expect(parseHoursForm(form({}))).toEqual({ body: { hours: [] } });
  });

  it("names the weekday of each mistake", () => {
    expect(
      parseHoursForm(
        form({
          [hourField(2, 0, "start")]: "08:00",
          [hourField(3, 0, "start")]: "12:00",
          [hourField(3, 0, "end")]: "08:00",
          [hourField(4, 0, "start")]: "08:00",
          [hourField(4, 0, "end")]: "13:00",
          [hourField(4, 1, "start")]: "12:00",
          [hourField(4, 1, "end")]: "18:00",
          [hourField(5, 0, "start")]: "08:03",
          [hourField(5, 0, "end")]: "12:00",
        }),
      ),
    ).toEqual({
      errors: [
        "Terça: preencha o início e o fim.",
        "Quarta: o fim precisa ser depois do início.",
        "Sexta: use horários de 5 em 5 minutos.",
        "Quinta: os dois horários se sobrepõem.",
      ],
    });
  });

  it("prefills and summarizes saved hours", () => {
    const hours = [
      { weekday: 1, startMinute: 780, endMinute: 1080 },
      { weekday: 1, startMinute: 480, endMinute: 720 },
      { weekday: 3, startMinute: 480, endMinute: 720 },
    ];
    expect(rangesOf(hours, 1)).toEqual([
      { start: "08:00", end: "12:00" },
      { start: "13:00", end: "18:00" },
    ]);
    expect(describeHours(hours)).toBe("Seg 08:00–12:00, 13:00–18:00 · Qua 08:00–12:00");
    expect(describeHours([])).toBe("Sem horário de atendimento");
  });
});

describe("parseProcedureForm", () => {
  it("reads the price in reais, empty meaning after evaluation", () => {
    expect(
      parseProcedureForm(form({ name: "Limpeza", durationMinutes: "45", price: "250,00" })),
    ).toEqual({ body: { name: "Limpeza", durationMinutes: 45, priceCents: 250_00, active: true } });
    expect(
      parseProcedureForm(form({ name: "Avaliação", durationMinutes: "30", price: "" })),
    ).toMatchObject({ body: { priceCents: null } });
    expect(parseProcedureForm(form({ name: "", durationMinutes: "42", price: "abc" }))).toEqual({
      errors: [
        "Informe o nome do procedimento.",
        "A duração vai de 5 a 480 minutos, de 5 em 5.",
        "Preço inválido. Exemplo: 250,00",
      ],
    });
    expect(priceInput(1234_50)).toBe("1234,50");
    expect(priceInput(null)).toBe("");
  });
});

describe("parseBlockForm", () => {
  it("blocks whole days by default, one day when the end is empty", () => {
    expect(
      parseBlockForm(form({ dentistId: "d1", fromDate: "2026-12-24", reason: "Natal" })),
    ).toEqual({
      body: { dentistId: "d1", fromDate: "2026-12-24", toDate: "2026-12-24", reason: "Natal" },
    });
  });

  it("takes part of a day when both times are given", () => {
    expect(
      parseBlockForm(
        form({ dentistId: "d1", fromDate: "2026-12-24", fromTime: "13:00", toTime: "18:00" }),
      ),
    ).toMatchObject({ body: { fromMinute: 780, toMinute: 1080, reason: null } });
    expect(
      parseBlockForm(form({ dentistId: "d1", fromDate: "2026-12-24", fromTime: "13:00" })),
    ).toEqual({ errors: ["Para bloquear só parte do dia, preencha as duas horas."] });
    expect(
      parseBlockForm(
        form({ dentistId: "d1", fromDate: "2026-12-24", fromTime: "18:00", toTime: "13:00" }),
      ),
    ).toEqual({ errors: ["A hora final precisa ser depois da inicial."] });
  });

  it("rejects a missing dentist or an end before the start", () => {
    expect(parseBlockForm(form({ fromDate: "2026-12-24", toDate: "2026-12-20" }))).toEqual({
      errors: ["Escolha a dentista.", "O último dia precisa ser igual ou depois do primeiro."],
    });
  });
});

describe("setupGaps", () => {
  const ready: SetupView = {
    clinic: { name: "Clínica Sorriso", address: null, timeZone: "America/Sao_Paulo" },
    dentists: [
      {
        id: "d1",
        name: "Dra. Ana",
        cro: null,
        active: true,
        workingHours: [{ weekday: 1, startMinute: 480, endMinute: 720 }],
      },
    ],
    procedures: [{ id: "p1", name: "Limpeza", durationMinutes: 45, priceCents: 0, active: true }],
    blocks: [],
  };

  it("lists what keeps the bot from booking", () => {
    expect(setupGaps(ready)).toEqual([]);
    expect(setupGaps({ clinic: null, dentists: [], procedures: [], blocks: [] })).toEqual([
      "Salve os dados da clínica.",
      "Cadastre a dentista.",
      "Cadastre pelo menos um procedimento.",
    ]);
    expect(
      setupGaps({
        ...ready,
        dentists: [{ ...ready.dentists[0]!, workingHours: [] }],
        procedures: [{ ...ready.procedures[0]!, active: false }],
      }),
    ).toEqual([
      "Preencha os horários de atendimento da dentista.",
      "Cadastre pelo menos um procedimento.",
    ]);
  });
});

describe("describeBlock", () => {
  it("shows whole days as a date range and part of a day with times", () => {
    const at = (startsAt: string, endsAt: string) => describeBlock({ startsAt, endsAt });
    expect(at("2026-12-24T03:00:00Z", "2027-01-01T03:00:00Z")).toBe("24/12/2026 a 31/12/2026");
    expect(at("2026-12-24T03:00:00Z", "2026-12-25T03:00:00Z")).toBe("24/12/2026");
    expect(at("2026-12-24T16:00:00Z", "2026-12-24T21:00:00Z")).toBe("24/12/2026, 13:00 às 18:00");
    expect(at("2026-12-24T16:00:00Z", "2026-12-26T15:00:00Z")).toBe(
      "24/12/2026 13:00 a 26/12/2026 12:00",
    );
  });
});
