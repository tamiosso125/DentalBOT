import { redirect } from "next/navigation";
import { api, ApiError } from "@/lib/api";

/** Opens the Asaas payment page of an installment, to copy and send to the patient. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let url: string;
  try {
    ({ url } = await api.paymentLink(id));
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 409))
      redirect(`/cobrancas?aviso=${encodeURIComponent(err.detail)}`);
    throw err;
  }
  redirect(url);
}
