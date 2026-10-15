import "server-only";
import { panelConfig } from "./config";

/** Typed client for the DentalBOT staff API (/admin/*), called from the panel server. */

export type AgendaRow = {
  id: string;
  startsAt: string;
  endsAt: string;
  status: string;
  procedureName: string;
  dentistName: string;
  patientId: string;
  patientName: string;
  patientPhone: string;
};
export type PatientRow = { id: string; name: string; phone: string };
export type Catalog = {
  timeZone: string;
  dentists: Array<{ id: string; name: string; cro: string | null }>;
  procedures: Array<{
    id: string;
    name: string;
    durationMinutes: number;
    priceCents: number | null;
  }>;
};
export type QuoteRow = {
  id: string;
  status: string;
  patientName: string;
  totalCents: number;
  installmentCount: number;
  validUntil: string | null;
  createdAt: string;
  sentAt: string | null;
  respondedAt: string | null;
};
export type QuoteDetail = QuoteRow & {
  patientId: string;
  dentistName: string;
  notes: string | null;
  items: Array<{
    description: string;
    quantity: number;
    unitPriceCents: number;
    coverage: "PRIVATE" | "INSURANCE";
  }>;
};
export type HandoffRow = {
  conversationId: string;
  contact: string;
  patientName: string | null;
  pausedUntil: string;
  lastInboundAt: string | null;
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`DentalBOT API ${status}: ${detail}`);
    this.name = "ApiError";
  }
}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const { apiUrl, apiToken } = panelConfig();
  const res = await fetch(`${apiUrl}${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      authorization: `Bearer ${apiToken}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = ((await res.json()) as { error?: string }).error ?? detail;
    } catch {
      // Not JSON: keep the status text.
    }
    throw new ApiError(res.status, detail);
  }
  return res;
}

const json = async <T>(path: string, init?: RequestInit) =>
  (await (await call(path, init)).json()) as T;

export const api = {
  agenda: (from: string, days: number) =>
    json<AgendaRow[]>(`/admin/agenda?from=${from}&days=${days}`),
  patients: (q: string) => json<PatientRow[]>(`/admin/patients?q=${encodeURIComponent(q)}`),
  catalog: () => json<Catalog>("/admin/catalog"),
  quotes: (status?: string) =>
    json<QuoteRow[]>(`/admin/quotes${status ? `?status=${status}` : ""}`),
  quote: (id: string) => json<QuoteDetail>(`/admin/quotes/${encodeURIComponent(id)}`),
  quotePdf: (id: string) => call(`/admin/quotes/${encodeURIComponent(id)}/pdf`),
  createQuote: (body: unknown) =>
    json<{ id: string }>("/admin/quotes", { method: "POST", body: JSON.stringify(body) }),
  sendQuote: (id: string) =>
    json<{ via: "session" | "template" }>(`/admin/quotes/${encodeURIComponent(id)}/send`, {
      method: "POST",
    }),
  handoffs: () => json<HandoffRow[]>("/admin/handoffs"),
};
