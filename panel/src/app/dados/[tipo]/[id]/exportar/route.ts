import { api, ApiError } from "@/lib/api";
import { parseSubject } from "@/lib/data-subject";

/** Downloads the patient's data (JSON) from the API, so the browser never sees the token. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ tipo: string; id: string }> },
) {
  const { tipo, id } = await params;
  const subject = parseSubject(tipo, id);
  if (!subject) return new Response("Não encontrado", { status: 404 });
  try {
    const res = await api.exportData(subject);
    return new Response(res.body, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": res.headers.get("content-disposition") ?? "attachment",
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404)
      return new Response("Não encontrado", { status: 404 });
    throw err;
  }
}
