import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify } from "jose";

/**
 * Route protection, deny-by-default: anything not explicitly public requires a
 * valid session cookie.
 *
 * This is a coarse gate only. It verifies the token signature and nothing
 * else — it cannot reach the database, so it knows nothing about roles,
 * department scope or client scope. Real authorization happens in
 * lib/services/ via lib/authz, and must never be skipped on the assumption
 * that middleware already checked (CLAUDE.md invariant #8).
 */
const PUBLIC_PATHS = ["/login", "/api/health"];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }

  const token = request.cookies.get("despl_session")?.value;
  if (token) {
    try {
      await jwtVerify(token, new TextEncoder().encode(process.env.AUTH_SECRET));
      return NextResponse.next();
    } catch {
      // fall through to redirect
    }
  }

  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
