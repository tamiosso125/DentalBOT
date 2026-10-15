import { api, ApiError } from "@/lib/api";

/** Streams the quote PDF from the API, so the browser never sees the API token. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const res = await api.quotePdf(id);
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
    throw err;
  }
}
