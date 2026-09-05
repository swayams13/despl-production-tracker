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
const PUBLIC_PATHS = ["/login", "/api/health", "/api/cron"];

// A failure is only findable in logs "by request id" (Phase 0 acceptance) if
// every request has one before it reaches a route handler — stamped here,
// once, rather than each handler generating its own (or, worse, none).
function withRequestId(request: NextRequest): { headers: Headers; requestId: string } {
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  const headers = new Headers(request.headers);
  headers.set("x-request-id", requestId);
  return { headers, requestId };
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const { headers, requestId } = withRequestId(request);

  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    const res = NextResponse.next({ request: { headers } });
    res.headers.set("x-request-id", requestId);
    return res;
  }

  const token = request.cookies.get("despl_session")?.value;
  if (token) {
    try {
      await jwtVerify(token, new TextEncoder().encode(process.env.AUTH_SECRET));
      const res = NextResponse.next({ request: { headers } });
      res.headers.set("x-request-id", requestId);
      return res;
    } catch {
      // fall through to redirect
    }
  }

  // API clients want a JSON 401, not an HTML redirect they'd silently follow.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: { code: "UNAUTHENTICATED", message: "Please sign in." } },
      { status: 401, headers: { "x-request-id": requestId } },
    );
  }

  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
