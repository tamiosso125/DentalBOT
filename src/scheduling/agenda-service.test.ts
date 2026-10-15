import { describe, expect, it } from "vitest";
import { AppointmentNotFoundError, SlotUnavailableError } from "./agenda-provider.js";
import { AgendaService } from "./agenda-service.js";
import { demoAgendaSeed, InMemoryAgendaRepository } from "./memory-agenda.js";

// Monday 2026-10-19, 09:00 in São Paulo.
const now = new Date("2026-10-19T12:00:00Z");

function setup() {
  const repo = new InMemoryAgendaRepository(demoAgendaSeed("clinic_a"));
  const agenda = new AgendaService(repo, { now: () => now });
  return { repo, agenda };
}

describe("AgendaService", () => {
  it("respects minimum notice and working hours", async () => {
    const { agenda } = setup();
    const slots = await agenda.listarHorarios({
      procedureId: "proc_limpeza",
      from: "2026-10-19",
      days: 1,
    });
    // 2h notice: first slot 11:00 (14:00 UTC); 45 min must fit before 12:00 and 18:00.
    expect(slots[0]!.startsAt.toISOString()).toBe("2026-10-19T14:00:00.000Z");
    expect(slots.at(-1)!.startsAt.toISOString()).toBe("2026-10-19T20:00:00.000Z");
  });

  it("books a slot once and refuses a double booking", async () => {
    const { agenda } = setup();
    const patient = await agenda.cadastrarPaciente({
      name: "Paciente Exemplo",
      phone: "5511900000001",
    });
    const [slot] = await agenda.listarHorarios({
      procedureId: "proc_limpeza",
      from: "2026-10-20",
      days: 1,
    });
    await agenda.reservar({ patientId: patient.id, slot: slot! });
    await expect(agenda.reservar({ patientId: patient.id, slot: slot! })).rejects.toBeInstanceOf(
      SlotUnavailableError,
    );
    const after = await agenda.listarHorarios({
      procedureId: "proc_limpeza",
      from: "2026-10-20",
      days: 1,
    });
    expect(after.some((s) => s.startsAt.getTime() === slot!.startsAt.getTime())).toBe(false);
  });

  it("rejects slots outside what it would offer (e.g. invented by a caller)", async () => {
    const { agenda } = setup();
    const patient = await agenda.cadastrarPaciente({
      name: "Paciente Exemplo",
      phone: "5511900000001",
    });
    const sunday = new Date("2026-10-18T13:00:00Z");
    await expect(
      agenda.reservar({
        patientId: patient.id,
        slot: {
          dentistId: "dentist_dev",
          procedureId: "proc_limpeza",
          startsAt: sunday,
          endsAt: new Date(sunday.getTime() + 45 * 60_000),
        },
      }),
    ).rejects.toBeInstanceOf(SlotUnavailableError);
  });

  it("only lets the owner reschedule or cancel", async () => {
    const { agenda } = setup();
    const owner = await agenda.cadastrarPaciente({ name: "Dona", phone: "5511900000001" });
    const other = await agenda.cadastrarPaciente({ name: "Outra", phone: "5511900000002" });
    const [a, b] = await agenda.listarHorarios({
      procedureId: "proc_avaliacao",
      from: "2026-10-20",
      days: 1,
    });
    const { appointmentId } = await agenda.reservar({ patientId: owner.id, slot: a! });

    await expect(
      agenda.remarcar({ appointmentId, patientId: other.id, slot: b! }),
    ).rejects.toBeInstanceOf(AppointmentNotFoundError);
    await expect(agenda.cancelar({ appointmentId, patientId: other.id })).rejects.toBeInstanceOf(
      AppointmentNotFoundError,
    );

    await agenda.remarcar({ appointmentId, patientId: owner.id, slot: b! });
    const list = await agenda.consultasDoPaciente({ patientId: owner.id, from: now });
    expect(list.map((x) => x.startsAt)).toEqual([b!.startsAt]);

    await agenda.cancelar({ appointmentId, patientId: owner.id });
    expect(await agenda.consultasDoPaciente({ patientId: owner.id, from: now })).toEqual([]);
  });

  it("lets a reschedule overlap the appointment's own old time", async () => {
    const { agenda } = setup();
    const p = await agenda.cadastrarPaciente({ name: "Paciente", phone: "5511900000001" });
    const slots = await agenda.listarHorarios({
      procedureId: "proc_resina",
      from: "2026-10-20",
      days: 1,
    });
    const { appointmentId } = await agenda.reservar({ patientId: p.id, slot: slots[0]! });
    // 30 min later overlaps the current 60-min appointment, which is being moved.
    const later = {
      ...slots[0]!,
      startsAt: new Date(slots[0]!.startsAt.getTime() + 30 * 60_000),
      endsAt: new Date(slots[0]!.endsAt.getTime() + 30 * 60_000),
    };
    await agenda.remarcar({ appointmentId, patientId: p.id, slot: later });
    const [appt] = await agenda.consultasDoPaciente({ patientId: p.id, from: now });
    expect(appt!.startsAt).toEqual(later.startsAt);
  });
});
