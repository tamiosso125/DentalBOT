import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSession, SESSION_COOKIE, type SessionUser } from "./lib/session";
import { config, middleware } from "./middleware";

const SECRET = "s".repeat(32);
const BIA: SessionUser = { id: "u2", name: "Bia", role: "RECEPTION" };

describe("middleware", () => {
  beforeEach(() => {
    process.env.PANEL_SESSION_SECRET = SECRET;
  });
  afterEach(() => {
    delete process.env.PANEL_SESSION_SECRET;
  });

  const request = (cookie?: string) =>
    new NextRequest("http://localhost:3001/orcamentos?status=SENT", {
      headers: cookie ? { cookie: `${SESSION_COOKIE}=${cookie}` } : {},
    });

  it("sends a visitor without a session to /login", async () => {
    const res = await middleware(request());
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost:3001/login");
  });

  it("refuses a forged or expired cookie", async () => {
    expect((await middleware(request("9999999999999.abc"))).status).toBe(307);
    const old = await createSession(SECRET, BIA, Date.parse("2026-01-01T00:00:00Z"));
    expect((await middleware(request(old))).status).toBe(307);
  });

  it("lets a valid session through", async () => {
    const res = await middleware(request(await createSession(SECRET, BIA)));
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("locks everything when the secret is missing", async () => {
    const cookie = await createSession(SECRET, BIA);
    delete process.env.PANEL_SESSION_SECRET;
    expect((await middleware(request(cookie))).status).toBe(307);
  });

  it("leaves only /login and static assets out of the check", () => {
    const covered = new RegExp(`^${config.matcher[0]}$`);
    expect(covered.test("/login")).toBe(false);
    expect(covered.test("/login/")).toBe(false);
    expect(covered.test("/_next/static/chunk.js")).toBe(false);
    expect(covered.test("/")).toBe(true);
    expect(covered.test("/pacientes/p1")).toBe(true);
    // Only the exact /login page is open, not any path that merely starts with "login".
    expect(covered.test("/loginx")).toBe(true);
    expect(covered.test("/login-admin/x")).toBe(true);
  });
});
