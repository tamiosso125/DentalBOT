import "server-only";
import type { Attendance } from "./attendance";
import type { BillingSummary, Filter, InstallmentRow } from "./billing";
import type { RecallList } from "./recall";
import type { WaitlistList } from "./waitlist";
import type {
  BlockBody,
  CoverageBody,
  ProcedureBody,
  SetupView,
  WorkingWindow,
} from "./clinic-form";
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
export type AppointmentDetail = AgendaRow & { procedureId: string; dentistId: string };
export type StaffSlot = { dentistId: string; startsAt: string; endsAt: string };
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

export type DataRequestRow = {
  id: string;
  createdAt: string;
  patientId: string | null;
  patientName: string | null;
  contact: string;
};
export type PatientSummary = {
  id: string;
  name: string;
  phone: string;
  createdAt: string;
  anonymizedAt: string | null;
  appointments: number;
  quotes: number;
  openInstallments: number;
};
export type AnonymizeResult = {
  cancelledAppointments: number;
  conversations: number;
  messages: number;
};
export type { SetupView } from "./clinic-form";

/** Whose data: a registered patient, or a "MEUS DADOS" request from a conversation. */
export type DataSubject = { kind: "patients" | "data-requests"; id: string };

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
  appointment: (id: string) =>
    json<AppointmentDetail>(`/admin/appointments/${encodeURIComponent(id)}`),
  slots: (procedureId: string, from: string) =>
    json<StaffSlot[]>(
      `/admin/slots?procedureId=${encodeURIComponent(procedureId)}&from=${from}&days=1`,
    ),
  bookAppointment: (body: unknown) =>
    json<{ id: string; notified: boolean }>("/admin/appointments", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  rescheduleAppointment: (id: string, body: unknown) =>
    json<{ notified: boolean }>(`/admin/appointments/${encodeURIComponent(id)}/reschedule`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  cancelAppointment: async (id: string) => {
    await call(`/admin/appointments/${encodeURIComponent(id)}/cancel`, { method: "POST" });
  },
  attendance: () => json<Attendance>("/admin/attendance"),
  setAttendance: async (id: string, attended: boolean) => {
    await call(`/admin/appointments/${encodeURIComponent(id)}/attendance`, {
      method: "POST",
      body: JSON.stringify({ attended }),
    });
  },
  dataRequests: () => json<DataRequestRow[]>("/admin/data-requests"),
  resolveDataRequest: async (id: string) => {
    await call(`/admin/data-requests/${encodeURIComponent(id)}/resolve`, { method: "POST" });
  },
  patientSummary: (id: string) => json<PatientSummary>(`/admin/patients/${encodeURIComponent(id)}`),
  exportData: (s: DataSubject) => call(`/admin/${s.kind}/${encodeURIComponent(s.id)}/export`),
  anonymize: (s: DataSubject) =>
    json<AnonymizeResult>(`/admin/${s.kind}/${encodeURIComponent(s.id)}/anonymize`, {
      method: "POST",
    }),
  setup: () => json<SetupView>("/admin/setup"),
  saveClinic: async (body: { name: string; address: string | null }) => {
    await call("/admin/setup/clinic", { method: "PUT", body: JSON.stringify(body) });
  },
  createDentist: (body: { name: string; cro: string | null; active: boolean }) =>
    json<{ id: string }>("/admin/setup/dentists", { method: "POST", body: JSON.stringify(body) }),
  updateDentist: async (
    id: string,
    body: { name: string; cro: string | null; active: boolean },
  ) => {
    await call(`/admin/setup/dentists/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  },
  saveHours: async (dentistId: string, body: { hours: WorkingWindow[] }) => {
    await call(`/admin/setup/dentists/${encodeURIComponent(dentistId)}/hours`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  },
  createProcedure: (body: ProcedureBody) =>
    json<{ id: string }>("/admin/setup/procedures", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateProcedure: async (id: string, body: ProcedureBody) => {
    await call(`/admin/setup/procedures/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  },
  createPlan: (body: { name: string }) =>
    json<{ id: string }>("/admin/setup/plans", { method: "POST", body: JSON.stringify(body) }),
  updatePlan: async (id: string, body: { name: string }) => {
    await call(`/admin/setup/plans/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  },
  saveCoverage: async (planId: string, body: CoverageBody) => {
    await call(`/admin/setup/plans/${encodeURIComponent(planId)}/coverage`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  },
  installments: (filtro: Filter, quoteId?: string) =>
    json<InstallmentRow[]>(
      `/admin/installments?filtro=${filtro}${quoteId ? `&quoteId=${encodeURIComponent(quoteId)}` : ""}`,
    ),
  recall: () => json<RecallList>("/admin/recall"),
  setRecallConsent: async (patientId: string, granted: boolean) => {
    await call(`/admin/recall/${encodeURIComponent(patientId)}/consent`, {
      method: "POST",
      body: JSON.stringify({ granted }),
    });
  },
  waitlist: () => json<WaitlistList>("/admin/waitlist"),
  addToWaitlist: (body: { patientId: string; procedureId: string; until: string }) =>
    json<{ id: string }>("/admin/waitlist", { method: "POST", body: JSON.stringify(body) }),
  removeFromWaitlist: async (id: string) => {
    await call(`/admin/waitlist/${encodeURIComponent(id)}/remove`, { method: "POST" });
  },
  billingSummary: () => json<BillingSummary>("/admin/installments/summary"),
  paymentLink: (id: string) =>
    json<{ url: string }>(`/admin/installments/${encodeURIComponent(id)}/link`),
  createBlock: (body: BlockBody) =>
    json<{ id: string; appointments: number }>("/admin/setup/blocks", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  deleteBlock: async (id: string) => {
    await call(`/admin/setup/blocks/${encodeURIComponent(id)}`, { method: "DELETE" });
  },
};
