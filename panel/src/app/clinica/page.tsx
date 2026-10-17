import Link from "next/link";
import { api } from "@/lib/api";
import {
  describeBlock,
  describeCoverage,
  describeHours,
  describePrice,
  setupGaps,
} from "@/lib/clinic-form";
import { dateKey } from "@/lib/format";
import { Nav } from "../nav";
import {
  createBlock,
  createDentist,
  createPlan,
  createProcedure,
  deleteBlock,
  saveClinic,
} from "./actions";
import { ProcedureFields } from "./procedure-fields";
import { SetupForm } from "./setup-form";

export const dynamic = "force-dynamic";

/** Cadastro da clínica: what the bot offers comes from here. */
export default async function ClinicPage({
  searchParams,
}: {
  searchParams: Promise<{ aviso?: string }>;
}) {
  const { aviso } = await searchParams;
  const view = await api.setup();
  const gaps = setupGaps(view);
  const activeDentists = view.dentists.filter((d) => d.active);
  const today = dateKey(new Date());

  return (
    <>
      <Nav />
      <main id="conteudo">
        {aviso ? <p className="notice">{aviso}</p> : null}
        <h1>Cadastro da clínica</h1>
        {gaps.length ? (
          <section className="card">
            <h2 style={{ marginTop: 0 }}>Falta para o bot marcar consultas</h2>
            <ul>
              {gaps.map((g) => (
                <li key={g}>{g}</li>
              ))}
            </ul>
          </section>
        ) : (
          <p className="muted">
            Tudo pronto: o bot oferece os procedimentos ativos e os horários livres da agenda.
          </p>
        )}

        <section className="card">
          <h2 style={{ marginTop: 0 }}>Dados da clínica</h2>
          <SetupForm action={saveClinic} submit="Salvar dados">
            <div className="row">
              <label>
                Nome
                <input
                  name="name"
                  defaultValue={view.clinic?.name ?? ""}
                  required
                  maxLength={120}
                />
              </label>
              <label>
                Endereço
                <input name="address" defaultValue={view.clinic?.address ?? ""} maxLength={200} />
              </label>
            </div>
            <p className="muted" style={{ margin: 0 }}>
              O nome aparece nas mensagens e no orçamento em PDF. Fuso horário:{" "}
              {view.clinic?.timeZone ?? "America/Sao_Paulo"}.
            </p>
          </SetupForm>
        </section>

        {view.clinic ? (
          <>
            <section className="card">
              <h2 style={{ marginTop: 0 }}>Dentistas</h2>
              {view.dentists.length ? (
                <ul>
                  {view.dentists.map((d) => (
                    <li key={d.id}>
                      <Link href={`/clinica/dentistas/${encodeURIComponent(d.id)}`}>{d.name}</Link>
                      {d.cro ? <span className="muted"> · {d.cro}</span> : null}
                      {d.active ? null : <span className="badge"> Inativa</span>}
                      <br />
                      <span className="muted">{describeHours(d.workingHours)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">Nenhuma dentista cadastrada.</p>
              )}
              <h2>Adicionar dentista</h2>
              <SetupForm action={createDentist} submit="Adicionar">
                <div className="row">
                  <label>
                    Nome
                    <input name="name" required maxLength={120} />
                  </label>
                  <label>
                    CRO
                    <input name="cro" maxLength={30} placeholder="CRO-SP 00000" />
                  </label>
                </div>
              </SetupForm>
            </section>

            <section className="card">
              <h2 style={{ marginTop: 0 }}>Procedimentos e preços</h2>
              <p className="muted">
                O bot só fala de procedimentos ativos e só informa o preço particular cadastrado
                aqui. Sem preço, ele diz que o valor sai depois da avaliação.
              </p>
              {view.procedures.length ? (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Procedimento</th>
                        <th className="num">Duração</th>
                        <th className="num">Preço particular</th>
                        <th>Cuidados após</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {view.procedures.map((p) => (
                        <tr key={p.id}>
                          <td>
                            {p.name} {p.active ? null : <span className="badge">Inativo</span>}
                          </td>
                          <td className="num">{p.durationMinutes} min</td>
                          <td className="num">{describePrice(p.priceCents)}</td>
                          <td>
                            {p.aftercareText ? "Cadastrados" : <span className="muted">-</span>}
                          </td>
                          <td>
                            <Link href={`/clinica/procedimentos/${encodeURIComponent(p.id)}`}>
                              Editar
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
              <h2>Novo procedimento</h2>
              <SetupForm action={createProcedure} submit="Cadastrar procedimento">
                <ProcedureFields />
              </SetupForm>
            </section>

            <section className="card">
              <h2 style={{ marginTop: 0 }}>Convênios</h2>
              {view.insurancePlans.length ? (
                <ul>
                  {view.insurancePlans.map((p) => (
                    <li key={p.id}>
                      <Link href={`/clinica/convenios/${encodeURIComponent(p.id)}`}>{p.name}</Link>
                      <br />
                      <span className="muted">{describeCoverage(p.coverage)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">Nenhum convênio cadastrado.</p>
              )}
              <h2>Adicionar convênio</h2>
              <SetupForm action={createPlan} submit="Adicionar">
                <label>
                  Nome
                  <input name="name" required maxLength={60} placeholder="Odontoprev" />
                </label>
              </SetupForm>
            </section>

            <section className="card">
              <h2 style={{ marginTop: 0 }}>Bloqueios de agenda</h2>
              <p className="muted">
                Férias, feriados e compromissos: o bot não oferece horários nesses períodos.
                Consultas já marcadas continuam na agenda; remarque ou cancele cada uma.
              </p>
              {view.blocks.length ? (
                <ul>
                  {view.blocks.map((b) => (
                    <li key={b.id} style={{ marginBottom: 8 }}>
                      {describeBlock(b)}
                      {view.dentists.length > 1 ? (
                        <span className="muted"> · {b.dentistName}</span>
                      ) : null}
                      {b.reason ? <span className="muted"> · {b.reason}</span> : null}{" "}
                      <form action={deleteBlock.bind(null, b.id)} style={{ display: "inline" }}>
                        <button type="submit" className="secondary">
                          Remover
                        </button>
                      </form>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">Nenhum bloqueio programado.</p>
              )}
              {activeDentists.length ? (
                <>
                  <h2>Novo bloqueio</h2>
                  <SetupForm action={createBlock} submit="Bloquear">
                    <div className="row">
                      <label>
                        Dentista
                        <select name="dentistId" defaultValue={activeDentists[0]!.id}>
                          {activeDentists.map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Primeiro dia
                        <input type="date" name="fromDate" min={today} required />
                      </label>
                      <label>
                        Último dia
                        <input type="date" name="toDate" min={today} />
                      </label>
                    </div>
                    <div className="row">
                      <label>
                        Das (opcional)
                        <input type="time" name="fromTime" step={300} />
                      </label>
                      <label>
                        Até (opcional)
                        <input type="time" name="toTime" step={300} />
                      </label>
                      <label>
                        Motivo
                        <input name="reason" maxLength={120} placeholder="Férias, feriado..." />
                      </label>
                    </div>
                    <p className="muted" style={{ margin: 0 }}>
                      Sem horas, bloqueia os dias inteiros. Sem último dia, bloqueia só o primeiro.
                      Não escreva nome de paciente no motivo.
                    </p>
                  </SetupForm>
                </>
              ) : null}
            </section>
          </>
        ) : null}
      </main>
    </>
  );
}
