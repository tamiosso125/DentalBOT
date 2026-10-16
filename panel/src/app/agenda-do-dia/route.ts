import { api, ApiError } from "@/lib/api";

/** Streams the printable day sheet PDF from the API, so the browser never sees the token. */
export async function GET(req: Request) {
  const day = new URL(req.url).searchParams.get("dia") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return new Response("Dia inválido", { status: 400 });
  try {
    const res = await api.daySheet(day);
    return new Response(res.body, {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": res.headers.get("content-disposition") ?? "inline",
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof ApiError && (err.status === 400 || err.status === 404))
      return new Response("Não encontrado", { status: err.status });
    throw err;
  }
}
