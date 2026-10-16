import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/session";

/** The API no longer accepts this login (deactivated): drop the cookie and go to /login. */
export function GET(req: NextRequest) {
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = `?aviso=${encodeURIComponent("Sua sessão terminou. Entre de novo.")}`;
  const res = NextResponse.redirect(url);
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
