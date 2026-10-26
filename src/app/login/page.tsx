"use client";

import { useActionState, useEffect, useState } from "react";
import { login, type LoginState } from "@/app/actions/auth";
import { ThemeRoot } from "@/components/industrial/theme-root";

const initial: LoginState = {};

export default function LoginPage() {
  const [state, formAction, pending] = useActionState(login, initial);
  // The middleware's `?next=` (L2.2). Read after mount: this page is prerendered, and the server re-validates it.
  const [next, setNext] = useState("");
  // AUD-062: `session=ended` is set when a session cookie was present but no longer valid.
  const [ended, setEnded] = useState(false);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    setNext(q.get("next") ?? "");
    setEnded(q.get("session") === "ended");
  }, []);

  // Pre-authentication: there is no user row to read a preference from, so
  // /login always resolves as SYSTEM (+ no outdoor) and leans entirely on
  // ThemeRoot's inline script for the OS-light case.
  return (
    <ThemeRoot themePreference="SYSTEM" outdoorMode={false}>
      <main className="grid min-h-dvh place-items-center px-4">
        <div className="w-full max-w-sm">
          <div className="mb-6 text-center">
            <b className="text-[15px] tracking-[.5px]">DESPL Production Tracker</b>
            <span className="mt-1 block text-[11px] coarse:text-xs uppercase tracking-[1px] text-[var(--muted)]">
              Dhruv EPC Solutions Pvt. Ltd.
            </span>
          </div>

          <form action={formAction} className="card p-5">
            <input type="hidden" name="next" value={next} />
            <label className="block text-xs font-medium text-[var(--muted)]" htmlFor="identifier">
              Username or email
            </label>
            <input
              id="identifier"
              name="identifier"
              type="text"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              required
              autoFocus
              className="ws-detail mt-1.5"
            />

            <label className="mt-4 block text-xs font-medium text-[var(--muted)]" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              className="ws-detail mt-1.5"
            />

            {ended && !state.error ? (
              <p role="status" className="mt-4 rounded-[4px] border px-3 py-2 text-xs">
                Your session ended, sign in to continue
              </p>
            ) : null}

            {state.error ? (
              <p
                role="alert"
                className="mt-4 rounded-[4px] border px-3 py-2 text-xs"
                style={{
                  borderColor: "var(--s-overdue)",
                  background: "color-mix(in srgb, var(--s-overdue) 12%, transparent)",
                  color: "var(--s-overdue)",
                }}
              >
                {state.error}
              </p>
            ) : null}

            <button type="submit" disabled={pending} className="btn btn-accent mt-5 w-full disabled:opacity-60">
              {pending ? "Signing in…" : "Sign in"}
            </button>
          </form>

          <p className="mt-4 text-center text-[11px] coarse:text-xs text-[var(--muted)]">
            Accounts are created by an administrator. There is no self sign-up.
          </p>
        </div>
      </main>
    </ThemeRoot>
  );
}
