import { describe, expect, it } from "vitest";
import { canMarkAttendance, noShowFollowUpLabel, noShowRate } from "./attendance";

describe("noShowRate", () => {
  it("is null before anything is marked", () => {
    expect(noShowRate({ attended: 0, noShow: 0 })).toBeNull();
  });

  it("rounds the share of missed appointments", () => {
    expect(noShowRate({ attended: 2, noShow: 1 })).toBe(33);
    expect(noShowRate({ attended: 0, noShow: 4 })).toBe(100);
  });
});

describe("canMarkAttendance", () => {
  const now = new Date("2026-10-20T13:00:00Z");

  it("waits for the start time and skips cancelled appointments", () => {
    expect(canMarkAttendance({ startsAt: "2026-10-20T14:00:00Z", status: "CONFIRMED" }, now)).toBe(
      false,
    );
    expect(canMarkAttendance({ startsAt: "2026-10-20T12:00:00Z", status: "CONFIRMED" }, now)).toBe(
      true,
    );
    expect(canMarkAttendance({ startsAt: "2026-10-20T12:00:00Z", status: "NO_SHOW" }, now)).toBe(
      true,
    );
    expect(canMarkAttendance({ startsAt: "2026-10-20T12:00:00Z", status: "CANCELLED" }, now)).toBe(
      false,
    );
  });

  it("sums up the bot's invitations to rebook after a no-show", () => {
    const month = { attended: 3, noShow: 2, noShowNotices: 0, rebooked: 0 };
    expect(noShowFollowUpLabel(month)).toBeNull();
    expect(noShowFollowUpLabel({ ...month, noShowNotices: 1, rebooked: 1 })).toBe(
      "1 paciente que faltou recebeu o convite para remarcar; 1 marcou de novo",
    );
    expect(noShowFollowUpLabel({ ...month, noShowNotices: 2, rebooked: 0 })).toBe(
      "2 pacientes que faltaram receberam o convite para remarcar; 0 marcaram de novo",
    );
  });
});
