import Link from "next/link";
import { notFound } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import {
  APPOINTMENT_STATUS,
  dateKey,
  formatDate,
  formatDayHeading,
  formatTime,
} from "@/lib/format";
import { Nav } from "../../nav";
import { cancelAppointment, rescheduleAppointment } from "../actions";
import { CancelForm } from "../cancel-form";
import { SlotPicker } from "../slot-picker";

export const dynamic = "force-dynamic";

/** Remarcar ou cancelar uma consulta. */
export default async function AppointmentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ data?: string }>;
}) {
  const { id } = await params;
  const { data } = await searchParams;
  const a = await api.appointment(id).catch((err: unknown) => {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  });
  const editable = a.status === "PENDING_CONFIRMATION" || a.status === "CONFIRMED";
  const date = data && /^\d{4}-\d{2}-\d{2}$/.test(data) ? data : undefined;
  const [catalog, slots] = await Promise.all([
    api.catalog(),
    editable && date ? api.slots(a.procedureId, date) : Promise.resolve(null),
  ]);
  const dentists = Object.fromEntries(catalog.dentists.map((d) => [d.id, d.name]));

  return (
    <>
      <Nav />
      <main>
        <p>
          <Link href={`/?de=${dateKey(a.startsAt)}`}>← Agenda</Link>
        </p>
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
          <p className="muted">Esta consulta não pode mais ser alterada.</p>
        )}
      </main>
    </>
  );
}
