import Link from "next/link";
import {
  canReceiveAtClinic,
  CLINIC_METHODS,
  hasPaymentLink,
  installmentStatus,
  type InstallmentRow,
} from "@/lib/billing";
import { dateKey, formatCents, formatDate, formatDateTime } from "@/lib/format";
import { receiveInstallment } from "./actions";

/**
 * Installments table, shared by "Cobranças" and the quote page (without the patient column).
 * `back` is the page the "paid at the clinic" form returns to.
 */
export function InstallmentsTable(props: {
  rows: InstallmentRow[];
  back: string;
  showPatient?: boolean;
}) {
  const today = dateKey(new Date());
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Vencimento</th>
            {props.showPatient ? <th>Paciente</th> : null}
            <th>Parcela</th>
            <th className="num">Valor</th>
            <th>Situação</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {props.rows.map((r) => {
            const status = installmentStatus(r);
            return (
              <tr key={r.id}>
                <td>{formatDate(r.dueDate)}</td>
                {props.showPatient ? (
                  <td>
                    <Link href={`/orcamentos/${encodeURIComponent(r.quoteId)}`}>
                      {r.patientName}
                    </Link>{" "}
                    <span className="muted">final {r.patientPhone.slice(-4)}</span>
                  </td>
                ) : null}
                <td>
                  {r.number}/{r.of}
                </td>
                <td className="num">{formatCents(r.amountCents)}</td>
                <td>
                  <span className={`badge ${status.tone}`}>{status.label}</span>
                  {r.paidAt ? <span className="muted"> em {formatDateTime(r.paidAt)}</span> : null}
                  {r.late && r.overdueNoticeAt ? (
                    <div className="muted">
                      Aviso enviado em {formatDateTime(r.overdueNoticeAt)}
                    </div>
                  ) : null}
                </td>
                <td>
                  {hasPaymentLink(r) ? (
                    <a
                      href={`/cobrancas/${encodeURIComponent(r.id)}/link`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Link de pagamento
                    </a>
                  ) : null}
                  {canReceiveAtClinic(r) ? (
                    <details>
                      <summary>Pago na clínica</summary>
                      <form action={receiveInstallment.bind(null, r.id, props.back)}>
                        <label>
                          Forma
                          <select name="method" required defaultValue="">
                            <option value="" disabled>
                              Escolha
                            </option>
                            {Object.entries(CLINIC_METHODS).map(([value, label]) => (
                              <option key={value} value={value}>
                                {label}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          Dia
                          <input
                            type="date"
                            name="date"
                            required
                            max={today}
                            defaultValue={today}
                          />
                        </label>
                        <button type="submit">Registrar pagamento</button>
                      </form>
                    </details>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
