import { describe, expect, it } from "vitest";
import { createSession, isValidSession, safeEqual, SESSION_HOURS } from "./session";

const SECRET = "s".repeat(32);

describe("panel session", () => {
  it("accepts its own cookie until it expires", async () => {
    const now = Date.UTC(2026, 9, 19, 12);
    const value = await createSession(SECRET, now);
    expect(await isValidSession(value, SECRET, now + 1000)).toBe(true);
    expect(await isValidSession(value, SECRET, now + SESSION_HOURS * 3_600_000)).toBe(false);
  });

  it("rejects tampered, foreign or malformed cookies", async () => {
    const now = Date.now();
    const value = await createSession(SECRET, now);
    const [exp, sig] = value.split(".");
    const later = String(Number(exp) + 3_600_000);
    expect(await isValidSession(`${later}.${sig}`, SECRET, now)).toBe(false);
    expect(await isValidSession(value, "x".repeat(32), now)).toBe(false);
    for (const bad of [undefined, "", "abc", "123", ".sig", "12a.sig"])
      expect(await isValidSession(bad, SECRET, now)).toBe(false);
  });

  it("compares strings in constant time semantics", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});
