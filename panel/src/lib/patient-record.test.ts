import { describe, expect, it } from "vitest";
import {
  afterVisitLabel,
  authorLabel,
  birthLabel,
  countsLabel,
  pendingNotices,
  recallLabel,
} from "./patient-record";

const visit = {
  id: "a1",
  startsAt: "2026-10-13T13:00:00.000Z",
  status: "COMPLETED",
  procedure: "Extração simples",
  dentist: "Dra. Ana",
  authorization: null,
  surveyRating: null,
  aftercareAnswer: null,
} as const;

describe("patient record labels", () => {
  it("puts an opt-out before any consent", () => {
    const granted = { granted: true, at: "2026-10-01T12:00:00.000Z", source: "WHATSAPP" };
    expect(recallLabel({ recallConsent: null, marketingOptOutAt: null })).toBe(
      "Ainda não perguntado",
    );
    expect(recallLabel({ recallConsent: granted, marketingOptOutAt: null })).toBe(
      "Aceitou pelo WhatsApp",
    );
    expect(
      recallLabel({
        recallConsent: { ...granted, granted: false, source: "STAFF" },
        marketingOptOutAt: null,
      }),
    ).toBe("Não aceitou na recepção");
    expect(
      recallLabel({ recallConsent: granted, marketingOptOutAt: "2026-10-02T12:00:00.000Z" }),
    ).toBe("Pediu para não receber mensagens (PARAR)");
  });

  it("summarizes what came after a visit", () => {
    expect(afterVisitLabel(visit)).toBeNull();
    expect(
      afterVisitLabel({
        ...visit,
        authorization: "AUTHORIZED",
        aftercareAnswer: "HELP",
        surveyRating: 4,
      }),
    ).toBe("Convênio autorizou · Pós: pediu ajuda · Nota 4");
  });

  it("counts appointments in pt-BR, singular and plural", () => {
    expect(countsLabel({ upcoming: 1, attended: 2, noShow: 1, cancelled: 0 })).toBe(
      "1 marcada · 2 atendidas · 1 falta · 0 canceladas",
    );
  });

  it("names who wrote a note", () => {
    expect(authorLabel("RECEPTION")).toBe("Recepção");
    expect(authorLabel("DENTIST")).toBe("Dentista");
  });

  it("counts the age in whole years", () => {
    expect(birthLabel("1990-05-17", "2026-05-16")).toBe("17/05/1990 (35 anos)");
    expect(birthLabel("1990-05-17", "2026-05-17")).toBe("17/05/1990 (36 anos)");
  });
});

describe("pendingNotices", () => {
  const now = new Date("2026-10-17T12:00:00.000Z");
  const base = {
    balance: { openCents: 0, overdueCents: 0 },
    appointments: [] as Array<
      | typeof visit
      | (Omit<typeof visit, "status" | "authorization"> & {
          status: string;
          authorization: "AUTHORIZED" | "DENIED" | null;
        })
    >,
    counts: { upcoming: 0, attended: 0, noShow: 0, cancelled: 0 },
    medicalHistoryAt: "2026-10-01T12:00:00.000Z",
  };
  const appt = (
    startsAt: string,
    status: string,
    authorization: "AUTHORIZED" | "DENIED" | null = null,
  ) => ({
    ...visit,
    startsAt,
    status,
    authorization,
  });

  it("says nothing when nothing is pending", () => {
    expect(pendingNotices(base, now)).toEqual([]);
  });

  it("lists overdue money, unconfirmed visits this week and denied authorizations", () => {
    const notices = pendingNotices(
      {
        ...base,
        balance: { openCents: 30000, overdueCents: 15050 },
        appointments: [
          appt("2026-10-20T13:00:00.000Z", "PENDING_CONFIRMATION", "DENIED"),
          appt("2026-11-20T13:00:00.000Z", "PENDING_CONFIRMATION"),
        ],
      },
      now,
    );
    expect(notices).toEqual([
      expect.stringMatching(/^Parcelas vencidas: R\$\s150,50\.$/),
      "Consulta de 20/10/2026 ainda sem confirmação.",
      "O convênio negou a consulta de 20/10/2026.",
    ]);
  });

  it("flags a past visit nobody marked, but not a cancelled or completed one", () => {
    expect(
      pendingNotices(
        {
          ...base,
          appointments: [
            appt("2026-10-14T13:00:00.000Z", "CONFIRMED"),
            appt("2026-10-13T13:00:00.000Z", "COMPLETED"),
            appt("2026-10-12T13:00:00.000Z", "CANCELLED"),
          ],
        },
        now,
      ),
    ).toEqual(["Consulta de 14/10/2026 sem marcação de compareceu ou faltou."]);
  });

  it("asks for the anamnese only when a visit is coming", () => {
    const none = { ...base, medicalHistoryAt: null };
    expect(pendingNotices(none, now)).toEqual([]);
    expect(
      pendingNotices(
        { ...none, appointments: [appt("2026-11-20T13:00:00.000Z", "CONFIRMED")] },
        now,
      ),
    ).toEqual(["Anamnese ainda não preenchida e há consulta marcada."]);
  });
});
