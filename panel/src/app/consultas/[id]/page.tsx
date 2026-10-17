import Link from "next/link";
import { notFound } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { canWriteClinical } from "@/lib/clinical-record";
import { currentUser } from "@/lib/current-user";
import { canMarkAttendance } from "@/lib/attendance";
import {
  APPOINTMENT_STATUS,
  dateKey,
  formatDate,
  formatDateTime,
  formatDayHeading,
  formatTime,
} from "@/lib/format";
import { ClinicalEntryForm } from "../../clinical-entry-form";
import { MedicalAlerts } from "../../medical-alerts";
import { Nav } from "../../nav";
import {
  cancelAppointment,
  markAttendance,
  rescheduleAppointment,
  resendConfirmation,
  saveClinicalEntry,
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
  const [catalog, slots, insurance, entries, user] = await Promise.all([
    api.catalog(),
    editable && date ? api.slots(a.procedureId, date) : Promise.resolve(null),
    api.patientInsurance(a.patientId).catch((err: unknown) => {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }),
    a.status === "COMPLETED"
      ? api.clinicalRecord(a.patientId).catch((err: unknown) => {
          if (err instanceof ApiError && err.status === 404) return [];
          throw err;
        })
      : Promise.resolve([]),
    currentUser(),
  ]);
  const visitEntries = entries.filter((e) => e.appointmentId === a.id);
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
          <Link href={`/?de=${dateKey(a.startsAt)}`}>← Agenda</Link> ·{" "}
          <Link href={`/pacientes/${encodeURIComponent(a.patientId)}`}>Ficha do paciente</Link>
        </p>
        {notice ? <p className="notice">{notice}</p> : null}
        <h1>Consulta de {a.patientName}</h1>
        <MedicalAlerts
          alerts={a.medicalAlerts}
          anamnesisHref={`/pacientes/${encodeURIComponent(a.patientId)}/anamnese`}
        />
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

        {a.status === "COMPLETED" ? (
          <section className="card">
            <h2 style={{ marginTop: 0 }}>Atestado de comparecimento</h2>
            <p className="muted">
              PDF com o nome do paciente, o dia e o horário agendado e o nome e o CRO da dentista.
              Não leva o procedimento nem dado de saúde. Dias de afastamento ou CID são com a
              dentista. Envie pelo WhatsApp da clínica.
            </p>
            <a
              className="button secondary"
              href={`/consultas/${encodeURIComponent(a.id)}/atestado`}
              target="_blank"
              rel="noreferrer"
            >
              Baixar atestado
            </a>
          </section>
        ) : null}

        {a.status === "COMPLETED" ? (
          <section className="card" id="evolucao">
            <h2 style={{ marginTop: 0 }}>Evolução clínica</h2>
            <p className="muted">
              O que foi feito nesta consulta. Depois de assinado, o registro não é editado nem
              apagado: um erro se corrige com um adendo no{" "}
              <Link href={`/pacientes/${encodeURIComponent(a.patientId)}/prontuario`}>
                prontuário
              </Link>
              .
            </p>
            {visitEntries.map((e) => (
              <div key={e.id} style={{ marginBottom: 12 }}>
                <div className="muted">
                  {formatDateTime(e.at)} ·{" "}
                  {e.signedBy ? `assinado por ${e.signedBy}` : "assinatura removida"}
                  {e.amendsId ? " · adendo" : ""}
                </div>
                <div style={{ whiteSpace: "pre-wrap" }}>{e.data.performed}</div>
                {e.data.teeth.length > 0 ? <div>Dentes: {e.data.teeth.join(", ")}</div> : null}
                {e.data.notes ? (
                  <div className="muted" style={{ whiteSpace: "pre-wrap" }}>
                    {e.data.notes}
                  </div>
                ) : null}
              </div>
            ))}
            {visitEntries.length === 0 ? <p className="muted">Nada registrado ainda.</p> : null}
            {canWriteClinical(user) && visitEntries.length === 0 ? (
              <ClinicalEntryForm
                action={saveClinicalEntry.bind(null, a.id, a.patientId, back)}
                label="Assinar evolução"
                performedLabel="O que foi feito"
                signedBy={user?.name}
              />
            ) : null}
            {!canWriteClinical(user) && visitEntries.length === 0 ? (
              <p className="muted" style={{ marginBottom: 0 }}>
                Só a dentista registra a evolução.
              </p>
            ) : null}
          </section>
        ) : null}

        {a.status === "PENDING_CONFIRMATION" && new Date(a.startsAt) > new Date() ? (
          <section className="card">
            <h2 style={{ marginTop: 0 }}>Confirmação</h2>
            <p className="muted">
              O paciente ainda não confirmou. Reenvie o aviso com os botões Confirmar e Remarcar, no
              máximo uma vez por dia.
            </p>
            <form action={resendConfirmation.bind(null, a.id)}>
              <button type="submit" className="secondary">
                Reenviar confirmação
              </button>
            </form>
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
