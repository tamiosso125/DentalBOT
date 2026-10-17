/** Server-side form errors, announced to screen readers and not carried by colour alone. */
export function ErrorSummary({
  errors,
  title = "Revise antes de continuar",
}: {
  errors?: string[];
  title?: string;
}) {
  if (!errors?.length) return null;
  return (
    <section className="error-summary" role="alert">
      <p className="error-summary-title">
        <span aria-hidden="true">!</span> {title}
      </p>
      <ul>
        {errors.map((error) => (
          <li key={error}>{error}</li>
        ))}
      </ul>
    </section>
  );
}
