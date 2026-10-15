import { describe, expect, it } from "vitest";
import { parseBookingForm, parseRescheduleForm, slotValue } from "./appointment-form";

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

const SLOT = slotValue({ dentistId: "d1", startsAt: "2026-10-20T17:00:00.000Z" });

describe("parseBookingForm", () => {
  it("books an existing patient and keeps the notify checkbox", () => {
    expect(
      parseBookingForm(form({ patientId: "p1", procedureId: "proc", slot: SLOT, notify: "on" })),
    ).toEqual({
      body: {
        patient: { id: "p1" },
        procedureId: "proc",
        dentistId: "d1",
        startsAt: "2026-10-20T17:00:00.000Z",
        notify: true,
      },
    });
    const quiet = parseBookingForm(form({ patientId: "p1", procedureId: "proc", slot: SLOT }));
    expect("body" in quiet && quiet.body.notify).toBe(false);
  });

  it("asks for name and phone of a new patient", () => {
    expect(
      parseBookingForm(
        form({ name: "João Exemplo", phone: "(11) 90000-0002", procedureId: "proc", slot: SLOT }),
      ),
    ).toMatchObject({ body: { patient: { name: "João Exemplo", phone: "(11) 90000-0002" } } });
    expect(
      parseBookingForm(form({ name: "Jo", phone: "123", procedureId: "proc", slot: SLOT })),
    ).toEqual({
      errors: ["Informe o nome completo do paciente.", "Informe o celular com DDD."],
    });
  });

  it("rejects a missing or tampered slot", () => {
    for (const slot of ["", "d1", "d1|ontem", "d1|2026-10-20T17:00:00.000Z|x"]) {
      expect(parseBookingForm(form({ patientId: "p1", procedureId: "proc", slot }))).toEqual({
        errors: ["Escolha um horário."],
      });
    }
  });
});

describe("parseRescheduleForm", () => {
  it("needs a slot", () => {
    expect(parseRescheduleForm(form({ slot: SLOT, notify: "on" }))).toEqual({
      body: { dentistId: "d1", startsAt: "2026-10-20T17:00:00.000Z", notify: true },
    });
    expect(parseRescheduleForm(form({}))).toEqual({ errors: ["Escolha o novo horário."] });
  });
});
