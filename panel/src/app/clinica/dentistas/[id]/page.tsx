import Link from "next/link";
import { notFound } from "next/navigation";
import { api } from "@/lib/api";
import { hourField, RANGES_PER_DAY, rangesOf, WEEKDAYS } from "@/lib/clinic-form";
import { Nav } from "../../../nav";
import { saveHours, updateDentist } from "../../actions";
import { SetupForm } from "../../setup-form";

export const dynamic = "force-dynamic";

const RANGE_LABELS = ["Manhã", "Tarde"];

export default async function DentistPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ aviso?: string }>;
}) {
  const [{ id }, { aviso }] = await Promise.all([params, searchParams]);
  const dentist = (await api.setup()).dentists.find((d) => d.id === id);
  if (!dentist) notFound();

  return (
    <>
      <Nav />
      <main id="conteudo">
        {aviso ? <p className="notice">{aviso}</p> : null}
        <p>
          <Link href="/clinica">← Cadastro da clínica</Link>
        </p>
        <h1>{dentist.name}</h1>

        <section className="card">
          <h2 style={{ marginTop: 0 }}>Horários de atendimento</h2>
          <p className="muted">
            O bot só oferece horários dentro destes períodos, tirando as consultas marcadas e os
            bloqueios. Deixe em branco os dias sem atendimento.
          </p>
          <SetupForm action={saveHours.bind(null, dentist.id)} submit="Salvar horários">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Dia</th>
                    {RANGE_LABELS.slice(0, RANGES_PER_DAY).map((l) => (
                      <th key={l}>{l}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {WEEKDAYS.map((day, weekday) => {
                    const ranges = rangesOf(dentist.workingHours, weekday);
                    return (
                      <tr key={day}>
                        <td>{day}</td>
                        {Array.from({ length: RANGES_PER_DAY }, (_, r) => (
                          <td key={r}>
                            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                              <input
                                type="time"
                                step={300}
                                aria-label={`${day}, ${RANGE_LABELS[r]}, início`}
                                name={hourField(weekday, r, "start")}
                                defaultValue={ranges[r]?.start}
                              />
                              até
                              <input
                                type="time"
                                step={300}
                                aria-label={`${day}, ${RANGE_LABELS[r]}, fim`}
                                name={hourField(weekday, r, "end")}
                                defaultValue={ranges[r]?.end}
                              />
                            </div>
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </SetupForm>
        </section>

        <section className="card">
          <h2 style={{ marginTop: 0 }}>Dados da dentista</h2>
          <SetupForm action={updateDentist.bind(null, dentist.id)} submit="Salvar">
            <div className="row">
              <label>
                Nome
                <input name="name" defaultValue={dentist.name} required maxLength={120} />
              </label>
              <label>
                CRO
                <input name="cro" defaultValue={dentist.cro ?? ""} maxLength={30} />
              </label>
            </div>
            <label className="check">
              <input type="hidden" name="activeField" value="1" />
              <input type="checkbox" name="active" defaultChecked={dentist.active} />
              Ativa (o bot oferece horários com ela)
            </label>
          </SetupForm>
        </section>
      </main>
    </>
  );
}
