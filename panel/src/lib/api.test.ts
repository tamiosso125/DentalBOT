import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "./api";
import { createSession, SESSION_COOKIE } from "./session";

const jar = vi.hoisted(() => ({ cookie: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "dentalbot_panel" && jar.cookie ? { value: jar.cookie } : undefined,
  }),
}));
const redirect = vi.hoisted(() =>
  vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  }),
);
vi.mock("next/navigation", () => ({ redirect }));

const TOKEN = "t".repeat(40);

describe("API client", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    Object.assign(process.env, {
      DENTALBOT_API_URL: "http://api.test",
      ADMIN_API_TOKEN: TOKEN,
      PANEL_PASSWORD: "senha",
      PANEL_SESSION_SECRET: "s".repeat(32),
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
    jar.cookie = undefined;
  });

  it("says who is signed in, and signs out a login the API no longer accepts", async () => {
    expect(SESSION_COOKIE).toBe("dentalbot_panel");
    jar.cookie = await createSession("s".repeat(32), { id: "u1", name: "Bia", role: "RECEPTION" });
    fetchMock.mockResolvedValueOnce(Response.json([]));
    await api.handoffs();
    expect(fetchMock.mock.calls[0]![1]?.headers).toMatchObject({ "x-staff-user": "u1" });
    fetchMock.mockResolvedValueOnce(Response.json({ error: "session" }, { status: 401 }));
    await expect(api.handoffs()).rejects.toThrow("NEXT_REDIRECT /login/sair");
    // A wrong password at login is an answer to show, not a lost session.
    jar.cookie = undefined;
    fetchMock.mockResolvedValueOnce(
      Response.json({ error: "E-mail ou senha incorretos." }, { status: 401 }),
    );
    const err = await api.login({ email: "a@b.c", password: "x" }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 401, detail: "E-mail ou senha incorretos." });
    expect(fetchMock.mock.calls[2]![1]?.headers).not.toHaveProperty("x-staff-user");
  });

  it("calls the staff API with the bearer token and an encoded query", async () => {
    fetchMock.mockResolvedValue(Response.json([]));
    await api.patients("maria & joão");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://api.test/admin/patients?q=maria%20%26%20jo%C3%A3o");
    expect(init?.headers).toMatchObject({ authorization: `Bearer ${TOKEN}` });
    expect(init?.cache).toBe("no-store");
  });

  it("posts a quote as JSON", async () => {
    fetchMock.mockResolvedValue(Response.json({ id: "q1" }, { status: 201 }));
    expect(await api.createQuote({ patientId: "p1" })).toEqual({ id: "q1" });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init).toMatchObject({ method: "POST", body: '{"patientId":"p1"}' });
    expect(init?.headers).toMatchObject({ "content-type": "application/json" });
  });

  it("turns an API error into ApiError with its message", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: "preço ausente" }, { status: 422 }));
    const err = await api.createQuote({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 422, detail: "preço ausente" });
  });

  it("books, moves and cancels appointments on the staff routes", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ id: "a/1", notified: true }, { status: 201 }));
    fetchMock.mockResolvedValueOnce(Response.json({ notified: false }));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await api.bookAppointment({ procedureId: "p" })).toEqual({ id: "a/1", notified: true });
    await api.rescheduleAppointment("a/1", { startsAt: "x" });
    await api.cancelAppointment("a/1");
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ["http://api.test/admin/appointments", "POST"],
      ["http://api.test/admin/appointments/a%2F1/reschedule", "POST"],
      ["http://api.test/admin/appointments/a%2F1/cancel", "POST"],
    ]);
  });

  it("refuses to run without its settings", async () => {
    delete process.env.ADMIN_API_TOKEN;
    await expect(api.catalog()).rejects.toThrow(/ADMIN_API_TOKEN/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exports, anonymizes and resolves on the LGPD routes", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ clinic: "x" }));
    fetchMock.mockResolvedValueOnce(
      Response.json({ cancelledAppointments: 0, conversations: 1, messages: 2 }),
    );
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await api.exportData({ kind: "patients", id: "p/1" });
    expect(await api.anonymize({ kind: "data-requests", id: "r1" })).toMatchObject({ messages: 2 });
    await api.resolveDataRequest("r1");
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ["http://api.test/admin/patients/p%2F1/export", undefined],
      ["http://api.test/admin/data-requests/r1/anonymize", "POST"],
      ["http://api.test/admin/data-requests/r1/resolve", "POST"],
    ]);
  });
});
