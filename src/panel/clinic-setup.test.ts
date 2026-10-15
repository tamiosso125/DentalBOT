import { describe, expect, it } from "vitest";
import {
  blockRange,
  blockSchema,
  checkWorkingHours,
  ClinicSetupError,
  hoursSchema,
  procedureSchema,
} from "./clinic-setup.js";

const TZ = "America/Sao_Paulo";

describe("checkWorkingHours", () => {
  it("sorts the windows by weekday and start", () => {
    expect(
      checkWorkingHours([
        { weekday: 2, startMinute: 780, endMinute: 1080 },
        { weekday: 1, startMinute: 480, endMinute: 720 },
        { weekday: 2, startMinute: 480, endMinute: 720 },
      ]),
    ).toEqual([
      { weekday: 1, startMinute: 480, endMinute: 720 },
      { weekday: 2, startMinute: 480, endMinute: 720 },
      { weekday: 2, startMinute: 780, endMinute: 1080 },
    ]);
  });

  it("rejects overlapping or inverted windows with a message for the front desk", () => {
    const overlap = () =>
      checkWorkingHours([
        { weekday: 3, startMinute: 480, endMinute: 780 },
        { weekday: 3, startMinute: 720, endMinute: 1080 },
      ]);
    expect(overlap).toThrow(ClinicSetupError);
    expect(overlap).toThrow("Os horários de quarta se sobrepõem.");
    expect(() => checkWorkingHours([{ weekday: 6, startMinute: 720, endMinute: 480 }])).toThrow(
      "O horário de sábado termina antes de começar.",
    );
    // Touching windows are fine (lunch break of zero minutes).
    expect(
      checkWorkingHours([
        { weekday: 1, startMinute: 480, endMinute: 720 },
        { weekday: 1, startMinute: 720, endMinute: 1080 },
      ]),
    ).toHaveLength(2);
  });

  it("accepts only 5-minute steps inside the day", () => {
    const ok = { weekday: 1, startMinute: 480, endMinute: 720 };
    expect(hoursSchema.safeParse({ hours: [ok] }).success).toBe(true);
    expect(hoursSchema.safeParse({ hours: [{ ...ok, startMinute: 481 }] }).success).toBe(false);
    expect(hoursSchema.safeParse({ hours: [{ ...ok, endMinute: 1445 }] }).success).toBe(false);
    expect(hoursSchema.safeParse({ hours: [{ ...ok, weekday: 7 }] }).success).toBe(false);
  });
});

describe("procedureSchema", () => {
  it("takes the price in whole cents, or null for price after evaluation", () => {
    const base = { name: "Limpeza", durationMinutes: 45 };
    expect(procedureSchema.parse({ ...base, priceCents: 250_00 })).toMatchObject({
      priceCents: 250_00,
      active: true,
    });
    expect(procedureSchema.parse({ ...base, priceCents: null }).priceCents).toBeNull();
    expect(procedureSchema.safeParse({ ...base, priceCents: 250.5 }).success).toBe(false);
    expect(procedureSchema.safeParse({ ...base, priceCents: -1 }).success).toBe(false);
    expect(procedureSchema.safeParse({ ...base, durationMinutes: 42, priceCents: 0 }).success).toBe(
      false,
    );
  });
});

describe("blockRange", () => {
  const block = (b: Record<string, unknown>) =>
    blockSchema.parse({ dentistId: "d1", fromDate: "2026-12-24", toDate: "2026-12-25", ...b });

  it("covers whole clinic-local days, the last one included", () => {
    expect(blockRange(block({}), TZ)).toEqual({
      startsAt: new Date("2026-12-24T03:00:00Z"),
      endsAt: new Date("2026-12-26T03:00:00Z"),
    });
  });

  it("uses the given times when there are any", () => {
    expect(
      blockRange(block({ toDate: "2026-12-24", fromMinute: 13 * 60, toMinute: 18 * 60 }), TZ),
    ).toEqual({
      startsAt: new Date("2026-12-24T16:00:00Z"),
      endsAt: new Date("2026-12-24T21:00:00Z"),
    });
  });

  it("rejects backwards, too long or half-timed blocks", () => {
    expect(() => blockRange(block({ toDate: "2026-12-23" }), TZ)).toThrow(
      "O bloqueio termina antes de começar.",
    );
    expect(() =>
      blockRange(block({ toDate: "2026-12-24", fromMinute: 600, toMinute: 600 }), TZ),
    ).toThrow("O bloqueio termina antes de começar.");
    expect(() => blockRange(block({ toDate: "2028-01-01" }), TZ)).toThrow("no máximo um ano");
    expect(
      blockSchema.safeParse({
        dentistId: "d1",
        fromDate: "2026-12-24",
        toDate: "2026-12-24",
        fromMinute: 600,
      }).success,
    ).toBe(false);
  });

  it("turns an empty reason into null", () => {
    expect(block({ reason: "  " }).reason).toBeNull();
    expect(block({ reason: " Férias " }).reason).toBe("Férias");
  });
});
