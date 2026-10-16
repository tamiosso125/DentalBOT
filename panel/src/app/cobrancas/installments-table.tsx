import Link from "next/link";
import { hasPaymentLink, installmentStatus, type InstallmentRow } from "@/lib/billing";
import { formatCents, formatDate, formatDateTime } from "@/lib/format";

/** Installments table, shared by "Cobranças" and the quote page (without the patient column). */
export function InstallmentsTable(props: { rows: InstallmentRow[]; showPatient?: boolean }) {
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
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
