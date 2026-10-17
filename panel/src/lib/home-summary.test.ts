import { describe, expect, it } from "vitest";
import { appointmentTone, homeSummary } from "./home-summary";

const dayOf = (iso: string) => iso.slice(0, 10);
const base = {
  today: "2026-10-19",
  dayOf,
  waitingForReception: 0,
  attendanceToMark: 0,
  installmentsToCall: 0,
  authorizationsPending: 0,
};

describe("homeSummary", () => {
  it("counts only today's appointments that were not cancelled", () => {
    const items = homeSummary({
      ...base,
      rows: [
        { startsAt: "2026-10-19T12:00:00Z", status: "CONFIRMED" },
        { startsAt: "2026-10-19T13:00:00Z", status: "PENDING_CONFIRMATION" },
        { startsAt: "2026-10-19T14:00:00Z", status: "CANCELLED" },
        { startsAt: "2026-10-20T12:00:00Z", status: "PENDING_CONFIRMATION" },
      ],
    });
    expect(items[0]).toMatchObject({ label: "Consultas hoje", value: 2, tone: "neutral" });
    expect(items[1]).toMatchObject({ value: 1, tone: "warn" });
  });

  it("marks only the items above zero as needing attention", () => {
    const items = homeSummary({ ...base, rows: [], installmentsToCall: 2, attendanceToMark: 1 });
    const byLabel = Object.fromEntries(items.map((i) => [i.label, i.tone]));
    expect(byLabel["Parcelas para ligar"]).toBe("danger");
    expect(byLabel["Presença sem marcar"]).toBe("warn");
    expect(byLabel["Esperando a recepção"]).toBe("neutral");
  });
});

describe("appointmentTone", () => {
  it("maps each status to a badge tone", () => {
    expect(appointmentTone("CONFIRMED")).toBe("ok");
    expect(appointmentTone("PENDING_CONFIRMATION")).toBe("warn");
    expect(appointmentTone("NO_SHOW")).toBe("danger");
    expect(appointmentTone("CANCELLED")).toBe("danger");
    expect(appointmentTone("COMPLETED")).toBe("done");
  });
});
