import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { safeNext } from "@/lib/shared/safe-next";

/**
 * AUD-062: a page that finds no usable session sends the person to /login with
 * the page they were on (`next`, stamped by middleware as `x-return-path`) and,
 * when a session cookie was present, `session=ended` so /login can say why.
 * Nothing is stored on the device beyond the cookie that already exists.
 */
export async function redirectToLogin(): Promise<never> {
  const q = new URLSearchParams();
  const next = safeNext((await headers()).get("x-return-path"));
  if (next) q.set("next", next);
  if ((await cookies()).has("despl_session")) q.set("session", "ended");
  redirect(q.size ? `/login?${q}` : "/login");
}
