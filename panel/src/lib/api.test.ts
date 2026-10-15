import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "./api";

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

  it("refuses to run without its settings", async () => {
    delete process.env.ADMIN_API_TOKEN;
    await expect(api.catalog()).rejects.toThrow(/ADMIN_API_TOKEN/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
