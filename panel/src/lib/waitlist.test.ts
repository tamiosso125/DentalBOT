import { describe, expect, it } from "vitest";
import {
  defaultUntil,
  lastOfferText,
  untilDay,
  waitlistStatus,
  type WaitlistRow,
} from "./waitlist";

const row = (r: Partial<WaitlistRow>): WaitlistRow => ({
  id: "w1",
  patientId: "p1",
  patientName: "Maria Exemplo",
  patientPhone: "***0001",
  procedureName: "Avaliação",
  until: "2026-10-23T03:00:00.000Z",
  status: "WAITING",
  createdAt: "2026-10-19T12:00:00.000Z",
  closedAt: null,
  offers: 0,
  lastOffer: null,
  ...r,
});

describe("waitlist helpers", () => {
  it("shows the last day the patient waits for", () => {
    expect(untilDay(row({}))).toBe("22/10/2026");
  });

  it("labels each status", () => {
    expect(waitlistStatus(row({}))).toEqual({ label: "Esperando vaga", tone: "warn" });
    expect(waitlistStatus(row({ status: "BOOKED" })).label).toBe("Marcou pela lista");
  });

  it("describes the last offer and its answer", () => {
    expect(lastOfferText(row({}))).toBeNull();
    const startsAt = "2026-10-20T13:00:00.000Z";
    expect(lastOfferText(row({ lastOffer: { startsAt, answer: null } }))).toBe(
      "20/10, 10:00 · sem resposta",
    );
    expect(lastOfferText(row({ lastOffer: { startsAt, answer: "TAKEN" } }))).toBe(
      "20/10, 10:00 · já tinha sido preenchida",
    );
  });

  it("suggests two weeks ahead", () => {
    expect(defaultUntil("2026-10-19")).toBe("2026-11-02");
  });
});
