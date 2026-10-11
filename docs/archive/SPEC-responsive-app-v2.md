# SPEC — Responsive Single-App Experience (v2)

**Date:** 2026-08-16 · **Status:** approved direction, ready to build
**Supersedes:** the separate-mobile-app design in `despl-floor-mobile-concept` and ADR §1.2 Part 1 (option A is now *responsive*, not a distinct mobile UI).
**Amends:** `PLAN-personal-dashboards-v1.md` — responsive is no longer a future phase; it is an **acceptance criterion on every UI session**.

**Read with:** CLAUDE.md invariants, DESIGN_SPEC.md (tokens/primitives), SPEC-personal-dashboards-v1.md, ADR-mobile-and-architecture-v1.md.

---

## 1. The decision

**One application, one route tree, one component set — responsive from 360px phone to 4K wall TV.** There is no separate mobile app, no `/m/*` routes, no duplicated screens. A supervisor on an Android tablet opens the same `/my-day` that SJ opens on a laptop; the layout adapts, the data and rules are identical.

### 1.1 Why this is the better call (not just the simpler one)

- **No drift.** Two UIs mean every future rule change ships twice and eventually diverges. One UI cannot disagree with itself.
- **Halves the surface a solo developer maintains** — and the earlier mobile concept implied ~6 bespoke screens that would have needed their own tests, translations and review cycles.
- **Training transfers.** A supervisor who learns the tablet can use the desktop; SJ can help someone over the phone because they're looking at the same thing.
- **It ships sooner.** Responsive work folds into sessions already planned instead of adding a phase.

### 1.2 What this deliberately gives up

Honest trade: a purpose-built mobile flow (job → vessel → step → update) can be marginally faster for one specific task than a responsive general page. The mitigation is §4 — the small-screen layouts are *designed*, not just squeezed — plus deep links so a WhatsApp notification opens straight to the item, which removes most of the navigation the bespoke flow existed to optimise.

---

## 2. Device targets

| Class | Width | Primary device | Posture |
|---|---|---|---|
| **Phone** | 360–639 px | Supervisor's own Android phone | One-handed, portrait, on the move |
| **Tablet** | 640–1023 px | 10" Android tablet, **landscape default** | Two hands or resting, gloves likely |
| **Desktop** | 1024 px+ | Office PC/laptop | Mouse + keyboard |
| **TV** | 1920 px+ | Wall display | Read-only, no interaction |

**Confirmed device spec (D18):** Android 12+, 10" screen, 4 GB RAM, rugged case, WiFi. Workshop tablets are used **landscape** — design tablet layouts landscape-first, but never break in portrait.

---

## 3. The responsive system

### 3.1 Two independent axes — this is the key technical decision

Screen width alone is the wrong signal. A 1280px tablet in landscape is **touch**; a 1280px laptop is **mouse**. Treat them as separate axes:

```css
/* Axis 1 — SIZE: how much fits */
@media (min-width: 640px)  { /* tablet+ */ }
@media (min-width: 1024px) { /* desktop+ */ }

/* Axis 2 — INPUT: how precisely the user can hit things */
@media (pointer: coarse) { /* touch: bigger targets, more spacing, larger base font */ }
@media (pointer: fine)   { /* mouse: denser layout, hover affordances */ }
```

Implement as a single density layer in `globals.css` inside `.theme-industrial`: on `pointer: coarse`, raise base font to 15px, control min-height to 48px, and row padding by ~40%. **Every component then inherits correct sizing with no per-component branching.** Tailwind: add a `coarse:` variant so this stays declarative.

### 3.2 Touch target standard (research-backed, not arbitrary)

NN/g's evidence-based minimum is **1 cm × 1 cm physical** (≈48 CSS px), with *larger targets required under imprecise conditions*. Gloved hands are imprecise. Therefore:

| Control | Minimum |
|---|---|
| Any interactive element on `pointer: coarse` | **48 × 48 px** |
| Primary shop-floor actions (Start, Complete, File reason, Claim) | **56 px height, full-width or half-width** |
| Spacing between adjacent targets | **≥ 8 px** |
| Destructive actions | never adjacent to a primary action |

### 3.3 Layout primitives

- **Container queries** for components rendered in multiple contexts (a plan row appears in `/my-day`, the board, and the Command Center at different widths). The component adapts to *its container*, not the viewport — which is what actually matters in a grid.
- **Viewport media queries** only for page-level structure (shell, columns).
- One shared `<ResponsiveTable>` primitive that renders a real table on `min-width: 1024px` and a card list below it, so no surface reinvents this.

---

## 4. Component degradation matrix — **the build contract**

"Scaled down" must be specified per surface, or it becomes "squeezed and unusable." Each row is testable.

| Surface | Desktop (1024+) | Tablet (640–1023) | Phone (360–639) |
|---|---|---|---|
| **App shell** | Left sidebar, top bar with job switcher + bell | Collapsible sidebar (icon rail), top bar intact | **Bottom nav** (Today · Jobs · Alerts · Profile), top bar becomes title + bell only |
| **/my-day inbox** | Table: priority, task, unit, due, reason, action | Table minus the "why" column; action button full-height | **Cards**: task name, unit chip, status chip, due — one full-width primary action per card |
| **KPI filter tabs** | 5–6 tabs in a row | Same, scrollable | Horizontally scrollable chip row, counts inline, first tab sticky |
| **Personal scoreboard** | 4 stats inline | 4 stats inline | 2 × 2 grid, collapsible under a "My stats" summary line |
| **Flow Board** | 5 columns side by side | 3 columns visible, horizontal scroll-snap | **Single column + state selector** at top (`Ready ▾`), swipe between states |
| **Execution sheet** | Right side sheet, 520 px | Right side sheet, 60% width | **Full-screen** with back arrow; actions pinned to a bottom bar in the thumb zone |
| **Command Center** | 2-col grid + 3–5 pipeline columns | Single column; pipeline horizontally scrollable | Sections stacked, "Decide today" first and expanded, pipeline collapsed by default |
| **Dashboard KPIs** | 4–5 across | 2 across | 2 across, compact |
| **Units × Stage matrix** | Full grid | Horizontal scroll, **sticky unit column** | Per-unit accordion: pick a unit → vertical stage list |
| **Gantt / timeline** | Full | Horizontal scroll | **Not rendered.** Show a card: "Timeline view is available on a larger screen" + link to the unit's stage list. Honest degradation beats an unusable grid |
| **Admin tables** | Full table | Table, fewer columns | Card list; Add-employee becomes a full-screen form |
| **TV mode** | — | — | Unaffected (1920+ only) |

**Rule:** any surface not listed here must be explicitly assigned a behaviour before it ships. "It probably reflows fine" is not an acceptance criterion.

---

## 5. Shop-floor environment requirements

These are what make a responsive page actually usable in a fabrication bay, and they're where most "mobile-friendly" apps fail.

1. **Outdoor / high-contrast mode.** The dark industrial theme is excellent indoors and poor near an open shutter in daylight. Ship a toggle (persisted per user) that raises contrast and switches to a light-on-dark high-luminance palette. Small effort, disproportionate real-world impact.
2. **Screen Wake Lock** (`navigator.wakeLock`) while a task is in progress on a touch device, released on submit — a screen that sleeps mid-entry loses the supervisor's place and their patience.
3. **Thumb-zone action bar.** On phone, the primary action is pinned bottom-centre, never top-right.
4. **Confirm destructive actions**, never confirm routine ones. A supervisor pressing "Start" 30 times a day must not face a dialog.
5. **No hover-only affordances anywhere.** Anything discoverable by hover must also be visible or tappable.
6. **Text ≥ 15px on coarse pointers**, status never conveyed by colour alone (colour + icon + word — already the DESIGN_SPEC rule).
7. **Latency honesty.** Every action shows an immediate optimistic state; a slow network must never look like a dead button.
8. **Theme is a per-user preference (D27): System / Light / Dark.** The app already renders both palettes (the Demo Readiness checklist verifies light *and* dark); what's new is user choice instead of silently following the OS. Selector lives in the top bar on supervisor surfaces and in profile/settings on desktop; stored per user; applied via a root class set by an inline pre-hydration script so there is no wrong-theme flash on load. Verification gates: status chips, KPI tiles and charts must hold AA contrast in *both* palettes — never light-only or dark-only checks. The outdoor high-contrast mode (D25) is orthogonal and **overrides the theme while active**; turning outdoor off returns to the user's chosen theme.

---

## 6. Photo capture (the one genuinely device-specific feature)

Shared component, mobile-aware behaviour — not a mobile-only screen.

- `<input type="file" accept="image/*" capture="environment">` opens the camera directly on Android; on desktop it opens a file picker. Same component, no branching.
- Client-side resize to ~1600 px long edge, JPEG ~80%, before upload.
- Geolocation captured alongside; **if permission is denied or accuracy is poor, save the photo without geo — never block the submission.**
- Upload to object storage via presigned URL (D20). DB stores key, hash, size, EXIF time, lat/lng, accuracy, uploader, and the plan it evidences.
- **Invariant #1 holds:** EXIF time and GPS are *evidence metadata*; the authoritative timestamp remains the server clock at acceptance. State this in a code comment at the write site.

---

## 7. PWA requirements (thin — this is not a phase)

`manifest.json` (name "DESPL Tracker", icons 192/512/maskable, `display: standalone`, `start_url: /my-day`, `theme_color: #0B0C0E`, `orientation: any`), a service worker caching the app shell **only** (no offline writes in v1), and the install prompt. Plus the outbox from D8: a failed submit is queued in IndexedDB with its photo blob, a persistent "1 update waiting to send" banner shows, retry fires on reconnect, and gates are checked server-side at delivery.

Android Chrome then offers a genuine one-tap install; at fleet scale it's pushed as a managed Google Play web app via MDM (ADR §2.2).

---

## 8. Revised build plan — what actually changes

**Responsive is a constraint, not a phase.** The four sessions stay; their acceptance criteria grow.

| Session | Was | Now |
|---|---|---|
| **A — person grain** | backend only | **Unchanged.** Start today; nothing here is affected. |
| **B — router + /my-day** | desktop page | Ship it responsive at all three widths per §4, with the §3.1 density layer built first (it's the foundation every later session inherits) |
| **C — Command Centers** | desktop pages | Responsive per §4 |
| **D — admin + notifications** | desktop | Responsive admin per §4; **add WhatsApp delivery** alongside in-app (ADR integration tier 1) |
| **E — PWA + photo (NEW, small)** | — | manifest, service worker, install, outbox, photo capture + object storage. Small because the UI already works on a phone. |

**Session B gains one task, executed first:**

> **Task 2.0 — Responsive foundation.** Add the density layer (§3.1) to `globals.css` inside `.theme-industrial`, the Tailwind `coarse:` variant, the shared `<ResponsiveTable>` primitive, and the bottom-nav shell variant. Retrofit the existing shell so every subsequent page inherits correct behaviour. Verify `/dashboard` and `/workspace` still render correctly at all three widths before building `/my-day`.

Doing this first is what prevents "we'll make it responsive later," which never happens.

---

## 9. Testing (you already have the tooling)

The repo has Playwright and an `e2e/` suite. Add a **viewport matrix** so responsive regressions fail CI rather than being discovered on the floor:

```
390 × 844   (phone portrait)
1024 × 768  (tablet landscape — the primary shop-floor device)
1440 × 900  (desktop)
```

Per session, assert for each new page: no horizontal overflow at 390px; every interactive element ≥ 48px on coarse pointer; the primary action is reachable without scrolling on phone; the §4 degradation actually happened (e.g. board shows one column at 390px, table becomes cards). Plus the existing rules: light and dark, no raw enums, full DB suite twice.

---

## 10. Decisions — revised and new

| # | Decision | Status |
|---|---|---|
| D17 ⟳ | Mobile delivery = **responsive PWA of the same app**, no separate mobile UI | **revised, approved** |
| D18 ✅ | Android 12+, 10", landscape-first, rugged case | confirmed by company |
| D23 | Density driven by `pointer: coarse`, not width alone | proposed |
| D24 | Gantt is **not rendered** below 640px (honest message + alternative link) | proposed — confirm with SJ |
| D25 | High-contrast outdoor mode toggle, persisted per user | proposed |
| D26 | WhatsApp notification delivery lands in Session D | proposed — needs BSP choice |
| D27 | Theme = per-user preference (System / Light / Dark), no-flash root-class application; outdoor (D25) overrides while active | **approved (user request, 16 Aug)** |
| D20 | Photo storage = S3-compatible object storage | **still open** — vendor call needed before Session E |
| D28 | `--muted-2`, light + outdoor palettes, coarse-pointer chip icon added to `.theme-industrial` (SPEC-supervisor-ui-v3.md §2.3) | **approved (17 Aug 2026)** |
| D29 | Canonical status labels (`stage-status.ts`) used on supervisor surfaces; floor wording, if wanted, changes that file globally (SPEC-supervisor-ui-v3.md §1) | **approved (17 Aug 2026)** |
| D30 | Supervisor surfaces use 12 / 10 radii and 15px body on `pointer: coarse`; desktop keeps 6 / 4 and 13px (SPEC-supervisor-ui-v3.md §5) | **approved (17 Aug 2026)** |
| D31 | Three new routes — `/board`, `/alerts`, `/profile` — under the `(app)` route group; no middleware change (existing catch-all matcher covers them) (SPEC-supervisor-ui-v3.md §4) | **approved (17 Aug 2026)** |
| D32 | `nudgeQc()` is new work in `notifications.service.ts` (R2); 30-min cooldown derived server-side from the last NUDGE `Notification` row, never client state (SPEC-supervisor-ui-v3.md §6(a)) | **approved (17 Aug 2026)** |

## 11. Open inputs

- BSP selection for WhatsApp (AiSensy / Gupshup / Interakt / Twilio) + a WABA-registered business number
- Object storage vendor + budget (blocks Session E)
- Confirmation that workshop tablets are hand-carried vs mounted (affects portrait support priority)
