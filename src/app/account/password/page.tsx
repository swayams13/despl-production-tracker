import { redirectToLogin } from "@/lib/auth/login-redirect";
import { getActor } from "@/lib/authz";
import { ChangePasswordForm } from "./_client";

/**
 * First-login password-change interstitial (personal dashboards v1, Task
 * 1.3). Lives OUTSIDE the (app) route group — same as /login — so the
 * (app) layout's `mustChangePassword` redirect here never loops.
 *
 * Any authenticated user may reach this page voluntarily to change their
 * password, not only a first-login `mustChangePassword` user; nothing in the
 * flow depends on that flag once here.
 */
export default async function ChangePasswordPage() {
  const actor = await getActor();
  if (!actor) return redirectToLogin();

  return (
    <ChangePasswordForm
      forced={actor.mustChangePassword}
      theme={{ themePreference: actor.themePreference, outdoorMode: actor.outdoorMode }}
    />
  );
}
