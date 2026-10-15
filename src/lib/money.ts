/** Formats integer cents as BRL ("R$ 1.200,00"). Only for display; never parse it back. */
export function formatCents(cents: number): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100);
}
