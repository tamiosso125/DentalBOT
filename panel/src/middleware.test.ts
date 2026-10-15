import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSession, SESSION_COOKIE } from "./lib/session";
import { middleware } from "./middleware";

const SECRET = "s".repeat(32);

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
    const old = await createSession(SECRET, Date.parse("2026-01-01T00:00:00Z"));
    expect((await middleware(request(old))).status).toBe(307);
  });

  it("lets a valid session through", async () => {
    const res = await middleware(request(await createSession(SECRET)));
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("locks everything when the secret is missing", async () => {
    const cookie = await createSession(SECRET);
    delete process.env.PANEL_SESSION_SECRET;
    expect((await middleware(request(cookie))).status).toBe(307);
  });
});
