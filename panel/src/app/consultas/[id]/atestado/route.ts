import { api, ApiError } from "@/lib/api";

/** Streams the attendance certificate PDF from the API, so the browser never sees the token. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const res = await api.attendanceCertificate(id);
    return new Response(res.body, {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": res.headers.get("content-disposition") ?? "inline",
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404)
      return new Response("Não encontrado", { status: 404 });
    // Not attended yet, or the patient asked for the data to be erased: say so on the page.
    if (err instanceof ApiError && err.status === 422)
      return new Response(null, {
        status: 303,
        headers: {
          location: `/consultas/${encodeURIComponent(id)}?aviso=${encodeURIComponent(err.detail)}`,
        },
      });
    throw err;
  }
}
