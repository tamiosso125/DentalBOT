import { describe, expect, it } from "vitest";
import { acceptanceRate, daysWaiting, waitingLabel } from "./quote-follow-up";

describe("quote follow-up helpers", () => {
  it("rates approvals over every answered or expired quote", () => {
    expect(acceptanceRate({ accepted: 0, rejected: 0, expired: 0 })).toBeNull();
    expect(acceptanceRate({ accepted: 2, rejected: 1, expired: 1 })).toBe(50);
    expect(acceptanceRate({ accepted: 1, rejected: 2, expired: 0 })).toBe(33);
  });

  it("counts whole days since sending", () => {
    const now = new Date("2026-10-22T12:00:00Z");
    expect(daysWaiting("2026-10-22T09:00:00Z", now)).toBe(0);
    expect(daysWaiting("2026-10-19T12:00:00Z", now)).toBe(3);
    expect(daysWaiting("2026-10-23T12:00:00Z", now)).toBe(0);
    expect(waitingLabel("2026-10-22T09:00:00Z", now)).toBe("hoje");
    expect(waitingLabel("2026-10-21T09:00:00Z", now)).toBe("há 1 dia");
    expect(waitingLabel("2026-10-19T12:00:00Z", now)).toBe("há 3 dias");
  });
});
