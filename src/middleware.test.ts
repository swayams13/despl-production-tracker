import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it } from "vitest";
import { middleware } from "./middleware";

// No token is ever minted here (CLAUDE.md: no hand-made sessions): every case is a missing or invalid cookie.
beforeAll(() => {
  process.env.AUTH_SECRET = "middleware-test-secret-not-used-anywhere-else";
});

const req = (path: string, init: { method?: string; cookie?: string; headers?: Record<string, string> } = {}) =>
  new NextRequest(`http://localhost${path}`, {
    method: init.method ?? "GET",
    headers: { ...(init.cookie ? { cookie: `despl_session=${init.cookie}` } : {}), ...init.headers },
  });
const loc = (res: Response) => new URL(res.headers.get("location") ?? "http://x/none");

describe("middleware: expired or missing session (AUD-062)", () => {
  it("a dead session cookie sends a page navigation to /login with the page and the 'ended' notice", async () => {
    const res = await middleware(req("/u/ABC123?step=4", { cookie: "not-a-valid-token" }));
    expect(res.status).toBeGreaterThanOrEqual(300);
    const url = loc(res);
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("next")).toBe("/u/ABC123?step=4");
    expect(url.searchParams.get("session")).toBe("ended");
  });

  it("no cookie at all: back to /login with the page, no 'ended' notice", async () => {
    const url = loc(await middleware(req("/qc")));
    expect(url.searchParams.get("next")).toBe("/qc");
    expect(url.searchParams.has("session")).toBe(false);
  });

  it("an API call without a session still gets a JSON 401, even if it claims to be a Server Action", async () => {
    const res = await middleware(req("/api/jobs", { method: "POST", headers: { "next-action": "abc" } }));
    expect(res.status).toBe(401);
  });

  it("a Server Action POST without a session reaches the action, which refuses with UNAUTHENTICATED", async () => {
    const res = await middleware(req("/u/ABC123", { method: "POST", headers: { "next-action": "abc" }, cookie: "expired" }));
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("a plain POST (no next-action header) without a session is still redirected", async () => {
    const res = await middleware(req("/u/ABC123", { method: "POST" }));
    expect(loc(res).pathname).toBe("/login");
  });
});
