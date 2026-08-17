# ADR — Mobile Integration, Tablet Rollout & App Architecture (v1)

**Date:** 2026-08-16 · **Status:** proposed for approval · **Decides:** how the supervisor mobile app connects to the tracker, how it gets onto shop-floor tablets, and whether to keep the single full-stack app or split into separate frontend/backend.

**Read with:** BUILD-SPEC-v2.md (decision #5 — single Next.js app), CLAUDE.md invariants, SPEC-personal-dashboards-v1.md (`/my-day` is mobile-first by design).

---

## Part 1 — How the mobile app integrates with the tracker

### 1.1 The core decision: the mobile app is not a separate system

The mobile app should be **the same application, rendered for a phone/tablet** — not a second codebase talking to the first over an API. Concretely: `/my-day` (Session B of the current build) is already specced mobile-first. Installed to a home screen as a PWA, that page *is* the supervisor app v1. There is no "integration" to build because there is nothing separate to integrate.

This matters more than it sounds. The alternative — a native app calling a REST API — means every rule (gating, maker–checker, hold points, delay blocking) has to be re-exposed through a second surface, and every future rule change has to be shipped twice, in sync, by a solo developer. That is how integrity rules drift apart.

### 1.2 Three options, ranked

| | Approach | Integration work | Camera/GPS | Offline | Verdict |
|---|---|---|---|---|---|
| **A** | **PWA — installed web app** (recommended) | **None.** Same origin, same session cookie, same server actions | Web APIs — good on Android | Service worker + outbox | **v1. Ship this.** |
| **B** | **Capacitor wrap of the same PWA** | Small — a shell project, plus token auth if it loads bundled assets | Native plugins (better camera, background sync) | Native storage | v2 *if* A proves insufficient |
| **C** | Native (React Native / Flutter) + REST API | Large — full API surface, token auth, DTO duplication, second test suite | Best | Best | **No.** Not justified at this team size |

**Recommendation: A now, keep B as the escape hatch.** Capacitor can wrap the *same* PWA later without rewriting the UI, so choosing A does not close the native door — it just defers the cost until there's evidence it's needed.

### 1.3 What actually has to be built for the PWA (the real work list)

Everything below is additive to the existing app. None of it touches `lib/services/`.

**a) PWA shell** — `public/manifest.json` (name, icons 192/512, `display: standalone`, `start_url: /my-day`, theme color `#0B0C0E`), a service worker (app-shell caching only in v1 — *not* offline writes), and an install prompt. Next.js supports this natively; no framework change.

**b) Auth — unchanged, and that's the point.** A PWA installed from `https://tracker.despl.…` runs on the same origin, so the existing session cookie works exactly as it does in a desktop browser. Requirements: cookies set `Secure; HttpOnly; SameSite=Lax`, and a **long-lived session for mobile** (supervisors should not re-login daily — propose 30-day rolling session, invalidated on password change/deactivation as already specced). No JWT, no token refresh, no second auth path.

**c) Photo capture + upload** — this is the one genuinely new subsystem, and it needs a storage decision the project has never made:

- Capture: `<input type="file" accept="image/*" capture="environment">` opens the camera directly. Simple, reliable, no camera API needed.
- Client-side resize before upload (target ≈1600px long edge, JPEG ~80%) — shop-floor WiFi is the constraint, not storage cost.
- **Storage: S3-compatible object storage with presigned upload URLs** (Cloudflare R2 or AWS S3). *Not* the database (bloats backups, kills restore times) and *not* local disk (Railway containers are ephemeral — files vanish on redeploy).
- DB stores only: object key, content hash, byte size, capture-time (EXIF), lat/lng, accuracy metres, uploader userId, and the plan/unit it evidences.
- **Invariant #1 stays intact:** the photo's EXIF timestamp and GPS are *evidence metadata*. The authoritative `actualFinish` is still the server clock at the moment the submission is accepted. Say this in code comments — it will otherwise get "fixed" wrongly later.

**d) Geolocation** — `navigator.geolocation.getCurrentPosition()`, requires HTTPS (already required for PWA). Store lat/lng + accuracy; render as a chip. If permission is denied or accuracy is poor (>100m), record the photo *without* geo rather than blocking the submission — a supervisor must never be unable to report finished work because GPS is sulking indoors.

**e) Offline behaviour — outbox, not full offline (decision D8 already taken)** — a failed submit is queued in IndexedDB with its photo blob, a persistent "1 update waiting to send" banner shows, and a background retry fires on reconnect. Server-side gating is checked at *delivery* time, so there is no offline conflict resolution to write. If the gate refuses on delivery, the item returns to the supervisor's queue with the refusal message.

**f) Push notifications** — Android PWA supports Web Push properly. iOS supports it only for home-screen-installed PWAs (16.4+). Both work for DESPL; deprioritise until the core loop is in use, since in-app notifications already exist.

### 1.4 API layer — build it, but inside the same app

Even staying with the monolith, define a small versioned API for the *future* Capacitor/native path and for any device that can't hold a cookie:

- `src/app/api/v1/*` Route Handlers, calling the **same `lib/services/` functions** the server actions call. Never a parallel implementation.
- Token auth for non-browser clients only: a device-scoped bearer token issued per user, revocable from `/admin`, and mapped to the identical actor object. Sessions remain the browser path.
- This is roughly a day of work and it means "we need a native app" is never a rewrite — it's a client swap.

---

## Part 2 — Getting the app onto supervisor tablets

### 2.1 Device recommendation: Android, not iPad

Not a preference — a functional difference for this use case:

| | Android tablet | iPad |
|---|---|---|
| PWA install | One-tap prompt; creates a real app (WebAPK) with its own icon and window | Manual Share → "Add to Home Screen"; no prompt can be triggered |
| **Offline cache retention** | Persistent | **Evicted after 7 days of non-use**; also cleared when Safari history is cleared |
| Storage budget | Hundreds of MB | ~50 MB, aggressive cleanup under storage pressure |
| Fleet management | Managed Google Play web apps + kiosk lockdown via MDM | Weaker for web apps |
| Cost per unit | ₹12–20k for a usable rugged-cased 10" | 3–4× |

The 7-day eviction alone disqualifies iPad for a device that might sit in a charging cradle over a shutdown week. **Spec: Android 12+, 10" screen, 4GB RAM, rugged case + screen protector, WiFi-only is fine if floor coverage is good.**

### 2.2 Install — three levels, pick by fleet size

**Level 1 — Manual (fine for 3–10 tablets, start here)**
1. Ensure the tracker is served over **HTTPS with a valid certificate** — PWA install is impossible without it.
2. On the tablet, open Chrome → navigate to `https://tracker.despl.…`
3. Chrome shows "Install app" (or ⋮ menu → *Add to Home screen* → *Install*).
4. The icon lands on the home screen and launches full-screen with no browser chrome.
5. Log in once as that supervisor; the 30-day session keeps them in.

**Level 2 — Managed rollout (10+ tablets, recommended once piloted)**
Enrol tablets in **Android Enterprise** with an MDM (Scalefusion, Hexnode, Miradore, or Google's own Android Management API — all support this). In the MDM console, create a **managed Google Play "Web App"** entry pointing at the tracker URL with display mode *standalone* and the DESPL icon, then push it to the device group. It installs automatically on every enrolled tablet, and updates centrally. No Play Store listing, no review, no APK.

**Level 3 — Kiosk lockdown (for fixed shop-floor stations)**
Same MDM, set the web app as the **kiosk app** so the tablet boots directly into the tracker and cannot run anything else. Fully Kiosk Browser is the common alternative if you're not running a full MDM. Use this for wall-mounted station tablets, not for personally carried devices — supervisors carrying a locked-down tablet can't take a call.

### 2.3 Practical rollout checklist (do these before handing out device #1)

- [ ] HTTPS + valid cert on the production URL (Let's Encrypt is fine)
- [ ] `manifest.json` + icons + service worker shipped and tested via Chrome DevTools → Application → Manifest
- [ ] **Shop-floor WiFi survey** — walk the bays with a phone; dead zones are the #1 cause of "the app doesn't work" complaints, and the outbox only masks short gaps
- [ ] One tablet per supervisor, labelled, with the personal credential slip from `/admin`
- [ ] Charging cradles at each bay + a spare tablet in the QC office
- [ ] 20-minute floor training in Hindi/Gujarati using the real device, not a projector
- [ ] Written fallback: if a tablet dies, the supervisor uses their phone browser at the same URL — no install needed

---

## Part 3 — Single full-stack app vs separate frontend/backend

### 3.1 Recommendation: **stay with the single Next.js app.** Do not split.

This confirms BUILD-SPEC-v2 decision #5 rather than reopening it, and the reasoning has strengthened since that decision was taken.

### 3.2 Why

**You already have the separation that matters.** The valuable boundary is *logical* — business rules isolated from presentation — and `lib/services/` already is that boundary, enforced by the project rule that server actions stay thin and never re-implement a gate. Splitting into two deployed apps adds a *physical* boundary that buys nothing you don't already have. A well-structured monolith with a service layer is the "modular monolith" pattern, and it is the correct architecture at this stage — not a compromise.

**The cost of splitting, for a solo developer, is real and recurring:** CORS configuration, a second auth mechanism (tokens instead of cookies), duplicated types/DTOs on both sides, two deployment pipelines, two test setups, two sets of environment secrets, network latency where there was a function call, and version-skew bugs when frontend and backend deploy out of step. Every one of those is a permanent tax on every future feature.

**You lose concrete capabilities.** Server Components fetch directly from the database with no API round trip; Server Actions give you type-safe mutations without hand-writing endpoints. Split the app and you rebuild both by hand, in exchange for nothing.

**The usual justification doesn't apply.** People split for: independent scaling profiles, multiple client apps owned by different teams, separate release cadences, or team sizes where merge contention hurts. DESPL has one developer, one database, one deployment, and — per Part 1 — one client. The mobile app is the same app.

### 3.3 What to do instead (gets the benefit without the cost)

1. **Keep enforcing the service-layer rule.** It's the real architecture. Every rule in `lib/services/`; actions and route handlers stay thin callers.
2. **Add `/api/v1/*` Route Handlers** for mobile/native/integration needs (Part 1.4) — an API surface *inside* the monolith, sharing the same services.
3. **Keep the database access layer clean** so services never leak Prisma types into UI components.
4. If PDF generation, image processing, or a scheduler ever becomes heavy, extract *that one job* into a worker — a targeted extraction, not a wholesale split.

### 3.4 When to revisit (write these down; revisit only if one becomes true)

- The team grows past ~4–5 developers and merge contention becomes a genuine bottleneck
- A second, independently-owned client appears (a customer portal built by a different team)
- One subsystem needs a fundamentally different scaling profile (e.g. heavy background NDT image processing)
- A non-JavaScript service becomes necessary (e.g. a Python analytics/ML service — which would be a *sidecar*, still not a split of the main app)

None are true today. Revisit when one is; not before.

---

## Decisions requested

| # | Decision | Recommendation |
|---|---|---|
| D17 | Mobile delivery mechanism | **PWA** (Capacitor deferred as escape hatch) |
| D18 | Tablet platform | **Android 12+, 10", rugged case** |
| D19 | Install method | Manual for the pilot → **managed Google Play web app via MDM** at scale |
| D20 | Photo storage backend | **S3-compatible object storage** (R2/S3) with presigned URLs — *needs a cost/vendor call* |
| D21 | Architecture | **Keep the single Next.js app**; add `/api/v1` route handlers for mobile |
| D22 | Mobile session length | **30-day rolling**, invalidated on password change/deactivation |

## Open inputs from DESPL

- Shop-floor WiFi coverage map / access-point plan (blocks the rollout checklist)
- Tablet budget and count (drives Level 1 vs Level 2 install)
- Whether tablets are personally carried or station-mounted (drives kiosk decision)
