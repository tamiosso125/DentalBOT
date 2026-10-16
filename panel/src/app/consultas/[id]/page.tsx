import Link from "next/link";
import { notFound } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { canMarkAttendance } from "@/lib/attendance";
import {
  APPOINTMENT_STATUS,
  dateKey,
  formatDate,
  formatDayHeading,
  formatTime,
} from "@/lib/format";
import { Nav } from "../../nav";
import {
  cancelAppointment,
  markAttendance,
  rescheduleAppointment,
  savePatientInsurance,
} from "../actions";
import { CancelForm } from "../cancel-form";
import { SlotPicker } from "../slot-picker";

export const dynamic = "force-dynamic";

/** Remarcar ou cancelar uma consulta. */
export default async function AppointmentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ data?: string; presenca?: string; aviso?: string }>;
}) {
  const { id } = await params;
  const { data, presenca, aviso } = await searchParams;
  const a = await api.appointment(id).catch((err: unknown) => {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  });
  const editable = a.status === "PENDING_CONFIRMATION" || a.status === "CONFIRMED";
  const date = data && /^\d{4}-\d{2}-\d{2}$/.test(data) ? data : undefined;
  const [catalog, slots, insurance] = await Promise.all([
    api.catalog(),
    editable && date ? api.slots(a.procedureId, date) : Promise.resolve(null),
    api.patientInsurance(a.patientId).catch((err: unknown) => {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }),
  ]);
  const dentists = Object.fromEntries(catalog.dentists.map((d) => [d.id, d.name]));
  const back = `/consultas/${encodeURIComponent(a.id)}`;
  const notice =
    aviso ??
    (presenca
      ? presenca === "faltou"
        ? "Falta registrada."
        : "Comparecimento registrado."
      : null);

  return (
    <>
      <Nav />
      <main>
        <p>
          <Link href={`/?de=${dateKey(a.startsAt)}`}>← Agenda</Link>
        </p>
        {notice ? <p className="notice">{notice}</p> : null}
        <h1>Consulta de {a.patientName}</h1>
        <section className="card">
          <p style={{ marginTop: 0 }}>
            {formatDayHeading(a.startsAt)}, {formatTime(a.startsAt)}–{formatTime(a.endsAt)} ·{" "}
            {a.procedureName} · {a.dentistName}
          </p>
          <p className="muted" style={{ marginBottom: 0 }}>
            Status: {APPOINTMENT_STATUS[a.status] ?? a.status} · celular final{" "}
            {a.patientPhone.slice(-4)}
          </p>
        </section>

        {insurance && insurance.plans.length > 0 ? (
          <section className="card">
            <h2 style={{ marginTop: 0 }}>Convênio do paciente</h2>
            <p className="muted">
              Com convênio, procedimentos que pedem autorização prévia aparecem em{" "}
              <Link href="/autorizacoes">Autorizações</Link>. O bot também pede a carteirinha na
              conversa.
            </p>
            <form className="row" action={savePatientInsurance.bind(null, a.patientId, back)}>
              <label>
                Convênio
                <select name="planId" defaultValue={insurance.planId ?? ""}>
                  <option value="">Particular</option>
                  {insurance.plans.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Carteirinha
                <input
                  name="card"
                  defaultValue={insurance.card ?? ""}
                  maxLength={40}
                  autoComplete="off"
                />
              </label>
              <div style={{ flex: "0 0 auto" }}>
                <button type="submit" className="secondary">
                  Salvar convênio
                </button>
              </div>
            </form>
          </section>
        ) : null}

        {canMarkAttendance(a) ? (
          <section className="card">
            <h2 style={{ marginTop: 0 }}>Comparecimento</h2>
            <p className="muted">
              {a.status === "COMPLETED" || a.status === "NO_SHOW"
                ? "Já marcada. Se a marcação estiver errada, corrija aqui."
                : "A consulta já começou. O paciente veio?"}
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <form action={markAttendance.bind(null, a.id, true, back)}>
                <button type="submit" disabled={a.status === "COMPLETED"}>
                  Compareceu
                </button>
              </form>
              <form action={markAttendance.bind(null, a.id, false, back)}>
                <button type="submit" className="secondary" disabled={a.status === "NO_SHOW"}>
                  Faltou
                </button>
              </form>
            </div>
          </section>
        ) : null}

        {editable ? (
          <>
            <h2>Remarcar</h2>
            <form className="card row" method="get">
              <label>
                Novo dia
                <input
                  type="date"
                  name="data"
                  required
                  defaultValue={date ?? dateKey(a.startsAt)}
                />
              </label>
              <div style={{ flex: "0 0 auto" }}>
                <button type="submit" className="secondary">
                  Ver horários
                </button>
              </div>
            </form>
            {slots && date ? (
              <>
                <p className="muted">Horários livres em {formatDate(date)}:</p>
                <SlotPicker
                  action={rescheduleAppointment.bind(null, a.id)}
                  slots={slots}
                  dentists={dentists}
                  hidden={{}}
                  submitLabel="Remarcar"
                />
              </>
            ) : null}
            <CancelForm action={cancelAppointment.bind(null, a.id)} />
          </>
        ) : (
          <p className="muted">Esta consulta não pode mais ser remarcada nem cancelada.</p>
        )}
      </main>
    </>
  );
}
