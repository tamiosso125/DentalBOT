import { NextResponse, type NextRequest } from "next/server";
import { readSession, SESSION_COOKIE } from "./lib/session";

/** Every page except /login needs a valid session cookie. */
export async function middleware(req: NextRequest) {
  const secret = process.env.PANEL_SESSION_SECRET;
  const ok =
    !!secret && (await readSession(req.cookies.get(SESSION_COOKIE)?.value, secret)) !== null;
  if (ok) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!login|_next/static|_next/image|favicon.ico).*)"],
};
