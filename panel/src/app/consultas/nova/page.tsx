import Link from "next/link";
import { api } from "@/lib/api";
import { dateKey, formatDate } from "@/lib/format";
import { Nav } from "../../nav";
import { bookAppointment } from "../actions";
import { SlotPicker } from "../slot-picker";

export const dynamic = "force-dynamic";

type Params = {
  q?: string;
  paciente?: string;
  nome?: string;
  novo?: string;
  procedimento?: string;
  data?: string;
};

/** Marcar consulta: 1) paciente, 2) procedimento e dia, 3) horário. Each step is a GET. */
export default async function NewAppointmentPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const sp = await searchParams;
  const query = sp.q?.trim() ?? "";
  const newPatient = sp.novo === "1";
  const chosen = !!sp.paciente || newPatient;
  const date = sp.data && /^\d{4}-\d{2}-\d{2}$/.test(sp.data) ? sp.data : undefined;
  const [catalog, results] = await Promise.all([
    api.catalog(),
    query.length >= 2 && !chosen ? api.patients(query) : Promise.resolve([]),
  ]);
  const procedure = catalog.procedures.find((p) => p.id === sp.procedimento);
  const slots = procedure && date ? await api.slots(procedure.id, date) : null;
  const dentists = Object.fromEntries(catalog.dentists.map((d) => [d.id, d.name]));
  const patientHidden: Record<string, string> = sp.paciente
    ? { paciente: sp.paciente, nome: sp.nome ?? "" }
    : { novo: "1" };

  return (
    <>
      <Nav />
      <main>
        <p>
          <Link href="/">← Agenda</Link>
        </p>
        <h1>Marcar consulta</h1>

        {!chosen ? (
          <section className="card">
            <form className="row" method="get">
              <label>
                Paciente (nome ou celular com DDD)
                <input name="q" defaultValue={query} minLength={2} required />
              </label>
              <div style={{ flex: "0 0 auto" }}>
                <button type="submit">Buscar</button>
              </div>
            </form>
            {query.length >= 2 ? (
              results.length === 0 ? (
                <p className="muted">Nenhum paciente encontrado.</p>
              ) : (
                <ul>
                  {results.map((p) => (
                    <li key={p.id}>
                      <Link
                        href={`?paciente=${encodeURIComponent(p.id)}&nome=${encodeURIComponent(p.name)}`}
                      >
                        {p.name}
                      </Link>{" "}
                      <span className="muted">final {p.phone.slice(-4)}</span>
                    </li>
                  ))}
                </ul>
              )
            ) : null}
            <p>
              <Link href="?novo=1">Paciente novo</Link>
            </p>
          </section>
        ) : (
          <>
            <p>
              Paciente: <strong>{newPatient ? "novo cadastro" : (sp.nome ?? "Paciente")}</strong>{" "}
              <Link href="/consultas/nova">trocar</Link>
            </p>
            <form className="card row" method="get">
              {Object.entries(patientHidden).map(([k, v]) => (
                <input key={k} type="hidden" name={k} value={v} />
              ))}
              <label>
                Procedimento
                <select name="procedimento" required defaultValue={procedure?.id ?? ""}>
                  <option value="" disabled>
                    Escolha
                  </option>
                  {catalog.procedures.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.durationMinutes} min)
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Dia
                <input
                  type="date"
                  name="data"
                  required
                  defaultValue={date ?? dateKey(new Date())}
                />
              </label>
              <div style={{ flex: "0 0 auto" }}>
                <button type="submit" className="secondary">
                  Ver horários
                </button>
              </div>
            </form>
            {slots && procedure && date ? (
              <>
                <h2>
                  {procedure.name} em {formatDate(date)}
                </h2>
                <SlotPicker
                  action={bookAppointment}
                  slots={slots}
                  dentists={dentists}
                  hidden={{
                    procedureId: procedure.id,
                    ...(sp.paciente ? { patientId: sp.paciente } : {}),
                  }}
                  newPatient={newPatient}
                  submitLabel="Marcar consulta"
                />
              </>
            ) : null}
          </>
        )}
      </main>
    </>
  );
}
