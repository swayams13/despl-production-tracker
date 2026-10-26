import { beforeEach, describe, expect, it, vi } from "vitest";

let returnPath: string | null = null;
let hasCookie = false;
vi.mock("next/headers", () => ({
  headers: async () => new Headers(returnPath === null ? {} : { "x-return-path": returnPath }),
  cookies: async () => ({ has: (n: string) => n === "despl_session" && hasCookie }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(to);
  },
}));

import { redirectToLogin } from "./login-redirect";

const to = () => redirectToLogin().then(() => "no redirect", (e: Error) => e.message);

beforeEach(() => {
  returnPath = null;
  hasCookie = false;
});

describe("redirectToLogin (AUD-062)", () => {
  it("never carries an off-site or login return path", async () => {
    for (const bad of ["//evil.example/x", "https://evil.example", "/\\evil", "/login?next=/x"]) {
      returnPath = bad;
      expect(await to(), bad).toBe("/login");
    }
  });

  it("a person who never had a session just gets the login page", async () => {
    expect(await to()).toBe("/login");
  });

  it("keeps the page and its query, and says the session ended when a cookie was present", async () => {
    returnPath = "/u/ABC123?step=4";
    hasCookie = true;
    expect(await to()).toBe("/login?next=%2Fu%2FABC123%3Fstep%3D4&session=ended");
  });

  it("no cookie: return path only, no 'ended' notice", async () => {
    returnPath = "/qc";
    expect(await to()).toBe("/login?next=%2Fqc");
  });
});
