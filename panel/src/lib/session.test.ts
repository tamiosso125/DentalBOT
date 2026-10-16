import { describe, expect, it } from "vitest";
import { createSession, readSession, safeEqual, SESSION_HOURS, type SessionUser } from "./session";

const SECRET = "s".repeat(32);
const ANA: SessionUser = { id: "u1", name: "Dra. Ana Lúcia", role: "DENTIST" };

describe("panel session", () => {
  it("carries the signed-in person until it expires", async () => {
    const now = Date.UTC(2026, 9, 19, 12);
    const value = await createSession(SECRET, ANA, now);
    expect(await readSession(value, SECRET, now + 1000)).toEqual(ANA);
    expect(await readSession(value, SECRET, now + SESSION_HOURS * 3_600_000)).toBeNull();
  });

  it("rejects tampered, foreign or malformed cookies", async () => {
    const now = Date.now();
    const value = await createSession(SECRET, ANA, now);
    const [, sig] = value.split(".");
    const forged = btoa(JSON.stringify({ exp: now + 1e9, id: "u1", name: "x", role: "DENTIST" }));
    expect(await readSession(`${forged}.${sig}`, SECRET, now)).toBeNull();
    expect(await readSession(value, "x".repeat(32), now)).toBeNull();
    // The cookie format before personal logins: everyone signs in again.
    expect(await readSession(`${now + 1000}.${sig}`, SECRET, now)).toBeNull();
    for (const bad of [undefined, "", "abc", "123", ".sig", "a.b.c"])
      expect(await readSession(bad, SECRET, now)).toBeNull();
  });

  it("compares strings in constant time semantics", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});
