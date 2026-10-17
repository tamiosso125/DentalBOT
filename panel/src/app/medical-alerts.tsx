import Link from "next/link";

/** Health warnings from the anamnesis, shown where the team acts; text and icon, not just colour. */
export function MedicalAlerts({
  alerts,
  anamnesisHref,
}: {
  alerts: string[];
  anamnesisHref?: string;
}) {
  if (alerts.length === 0) return null;
  return (
    <section className="med-alert" role="alert" aria-label="Alertas de saúde">
      <span className="med-alert-icon" aria-hidden="true">
        !
      </span>
      <div>
        <p className="med-alert-title">Atenção antes de atender</p>
        <ul>
          {alerts.map((alert) => (
            <li key={alert}>{alert}</li>
          ))}
        </ul>
        {anamnesisHref ? <Link href={anamnesisHref}>Ver anamnese completa</Link> : null}
      </div>
    </section>
  );
}
