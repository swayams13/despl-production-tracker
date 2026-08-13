"use client";

import { useActionState } from "react";
import { login, type LoginState } from "@/app/actions/auth";

const initial: LoginState = {};

export default function LoginPage() {
  const [state, formAction, pending] = useActionState(login, initial);

  return (
    <main className="grid min-h-dvh place-items-center bg-[var(--page)] px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6">
          <h1 className="text-lg font-semibold tracking-tight">DESPL Production Tracker</h1>
          <p className="mt-1 text-sm text-[var(--muted-fg)]">
            Dhruv EPC Solutions Pvt. Ltd.
          </p>
        </div>

        <form
          action={formAction}
          className="rounded-xl border border-[var(--hairline)] bg-[var(--surface)] p-5 shadow-sm"
        >
          <label className="block text-sm font-medium" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            required
            autoFocus
            className="mt-1.5 w-full rounded-lg border border-[var(--hairline)] bg-[var(--page)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-ring)]"
          />

          <label className="mt-4 block text-sm font-medium" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            className="mt-1.5 w-full rounded-lg border border-[var(--hairline)] bg-[var(--page)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-ring)]"
          />

          {state.error ? (
            <p
              role="alert"
              className="mt-4 rounded-lg border border-[var(--crit-border)] bg-[var(--crit-bg)] px-3 py-2 text-sm text-[var(--crit-fg)]"
            >
              {state.error}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={pending}
            className="mt-5 w-full rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {pending ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p className="mt-4 text-xs text-[var(--muted-fg)]">
          Accounts are created by an administrator. There is no self sign-up.
        </p>
      </div>
    </main>
  );
}
