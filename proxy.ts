import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth/session";

/**
 * First-pass route gate. (Next.js 16 renamed this file convention from
 * `middleware` to `proxy`; the behaviour is unchanged.)
 *
 * It runs on the edge runtime and cannot reach the database, so it verifies
 * the cookie signature and nothing more. This is a redirect for convenience,
 * NOT the authorisation boundary — a valid-but-stale token (suspended account,
 * revoked role) still gets past here.
 *
 * The real decision is made by lib/auth/rbac.ts inside the request, where the
 * student's current role can actually be read. Every protected page and action
 * must call requireStudent/requireRole; passing this gate is not enough.
 *
 * Nothing here grants access — it only redirects a signed-out visitor to the
 * login page early, so they are not shown a personal screen that would fail
 * inside the request anyway. A route omitted from the private list is not
 * thereby made safe; it is the page's own auth call that decides.
 */

/**
 * Reading the tracker needs no account, so the gate lists what is private
 * rather than what is public. Anything not named here is readable signed out:
 * the pages left off this list show cohort aggregates that are already
 * suppressed below a minimum group size.
 *
 * Adding a route that exposes one person's data, or that writes anything, means
 * adding it here AND calling requireStudent/requireRole inside it.
 */
const PRIVATE_PATHS = ["/me", "/submit", "/admin", "/api/export"];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const isPrivate = PRIVATE_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
  if (!isPrivate) {
    return NextResponse.next();
  }

  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = token ? await verifySessionToken(token) : null;

  if (!session) {
    const loginUrl = new URL("/login", request.url);
    if (pathname !== "/") {
      loginUrl.searchParams.set("next", pathname + request.nextUrl.search);
    }
    const response = NextResponse.redirect(loginUrl);
    // Clear a token that failed verification so the browser stops sending it.
    if (token) response.cookies.delete(SESSION_COOKIE_NAME);
    return response;
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Everything except Next.js internals and static assets. Note this
     * deliberately includes API routes.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
