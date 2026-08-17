# PLAN — Responsive Supervisor Experience, i18n & PWA (v1)

**Date:** 2026-08-16 · **Status:** ready to build **after** PLAN-personal-dashboards-v1 Sessions A–D are complete and merged to `demo`.
**Companion spec:** SPEC-responsive-app-v2.md (the contract — read every session). **Pixel reference (approved by team):** artifact `despl-supervisor-flow-v2` — the phone/tablet frames in that mockup are the acceptance target, including the queue-first flow, thumb-zone actions, outdoor mode, and EN/HI/GU switching.
**Branch:** `demo` only. Never push/merge `main` without explicit user approval.
**Session discipline:** one session per phase; end with tests green (`RUN_DB_TESTS=1 pnpm test` twice), `pnpm typecheck && pnpm lint && pnpm build` clean, browser click-test at all three viewports, progress.md updated. Do not advance with a failing check.

---

## 0. Where this sits

```
DONE (prior plan): A person-grain → B /my-day → C command centers → D admin+notifications
THIS PLAN:         R1 responsive foundation → R2 supervisor flow UI → R3 i18n EN/HI/GU → R4 PWA+photo+outbox
```

**R0 pre-check (first 10 minutes of Session R1):** if Session B already implemented SPEC-responsive-app-v2 §8 Task 2.0 (density layer, `coarse:` variant, `ResponsiveTable`, bottom-nav shell), R1 shrinks to verification + gap-fill. If B shipped desktop-only, R1 builds it all. Read progress.md's Session B log to decide — do not assume either way.

## Global constraints (every session)

1. CLAUDE.md invariants #1–#12; rules stay in `lib/services/` — **no session in this plan touches services except R4's photo-evidence write** (one new service function, specced below).
2. SPEC-responsive-app-v2 §3.2 touch standard is a hard gate: ≥48px interactive targets on `pointer: coarse`, 56px primary shop-floor actions, ≥8px spacing.
3. SPEC §4 degradation matrix is the contract; any surface not in the matrix gets an explicit behaviour decision before it ships.
4. No hover-only affordances; status = colour + icon + word; no raw enums in UI (hard bans — grep before commit).
5. Existing desktop layouts must not regress: every session re-verifies `/dashboard`, `/workspace`, `/my-day` at 1440px, light + dark.

## Viewport test matrix (added in R1, run in every session after)

Playwright projects: `390×844` (phone), `1024×768` (tablet landscape — primary shop-floor device), `1440×900` (desktop). Assertions per page: no horizontal overflow at 390; all interactive elements ≥48px on coarse; primary action visible without scrolling on phone; the specific §4 degradation happened (board = 1 column at 390, tables = cards, exec sheet = full-screen with pinned bottom bar).

---

## Session R1 — Responsive foundation + shell

### Tasks
1. **Density layer** in `globals.css` inside `.theme-industrial`: on `@media (pointer: coarse)` raise base font to 15px, control min-height to 48px, row padding ~+40%. Add Tailwind `coarse:`/`fine:` variants. No per-component branching — components inherit.
2. **`<ResponsiveTable>` primitive** (`components/industrial/responsive-table.tsx`): real table ≥1024px, card list below. Adopt it in `/my-day` and `/admin` Employees (the two highest-traffic tables) this session; other tables migrate opportunistically.
3. **Shell variants:** desktop sidebar (unchanged) → tablet icon rail → phone bottom nav (Today · Board · Alerts · Profile) with badge counts. Top bar on phone: title + bell only. Per the artifact: board icon is the framed glyph with bottom-aligned rising bars, small bar left / big bar right (team-approved iteration — copy the exact SVG from the artifact).
4. **Playwright viewport matrix** per above, wired into the standard test run.
5. **Theme preference (D27):** three-way System / Light / Dark, stored per user, selector in the desktop shell (profile menu) and supervisor top bar; applied as a root class by an inline pre-hydration script (no wrong-theme flash). Both palettes already exist in the token layer — this task adds the *choice*, plus an audit that status chips, KPI tiles and charts hold AA contrast in both. Outdoor mode (R2) overrides the theme while active and restores it on exit.

### Gate
`/dashboard`, `/workspace`, `/my-day`, `/admin` render correctly at all three viewports **in both themes via the new toggle** (not just OS preference); no flash-of-wrong-theme on hard reload; viewport suite green; zero desktop regressions; full suite + typecheck/lint/build clean.

## Session R2 — Supervisor flow UI (`/my-day` small-width behaviour per the artifact)

### Tasks
1. **Queue-first cards** at <640px: mine-first ranked cards, top card gets the "Do this first" treatment (accent border + ribbon), one primary action per card, Claim button directly on pool cards (56px). Personal scoreboard collapses to a summary line ("My stats — 86% on-time") expanding to a 2×2 grid. KPI tabs become a horizontally scrollable chip row.
2. **Execution sheet** goes full-screen below 640px: back arrow, 25-segment spine strip, state-correct content, **actions pinned to a bottom bar in the thumb zone** (56px). Overdue leads with the 6-button reason grid; "File reason & start" is one motion (existing delay action + start action chained server-side exactly as the current flow does — no new rule logic). Hold state renders the locked finish button + ITP ref + "Nudge QC" (notification to QC + PH with hold age). Submitted state is read-only with maker–checker copy.
3. **Board tab** on phone: single column + state selector chips with counts (Ready / In progress / With QC / Hold / Done), same payload as the desktop board. Tablet (640–1023): master-detail — list left, execution panel right, icon rail.
4. **Wake Lock:** acquire `navigator.wakeLock` while the viewer has an IN_PROGRESS item open on a coarse pointer; release on submit/close/visibility loss. Show the "screen stays on" chip. Feature-detect; silently skip where unsupported.
5. **Outdoor high-contrast mode (D25):** toggle in the top bar; a `.outdoor` class overriding the token layer (near-black bg, brighter text/muted, thicker borders); persisted per user (same preference store as the R1 theme choice). Orthogonal to D27: outdoor **overrides** the user's light/dark theme while active and restores it on exit — mirror the approved artifact's Dark → Light → Outdoor cycle on supervisor surfaces.

### Gate
The artifact's "try the full day" script passes in a real browser at 390px and 1024×768: overdue → reason → start; in-progress → submit; claim from pool; hold locked + nudge; board single-column; outdoor toggle. Desktop `/my-day` unchanged at 1440px. Viewport suite green.

## Session R3 — i18n (English / हिन्दी / ગુજરાતી)

**Scope decision (D6, locked):** translate the **supervisor-facing surfaces only** — `/my-day`, execution sheet, board, alerts, login, password interstitial. Office command centers, admin, and dashboards stay English in v1.

### Tasks
1. **String architecture:** `next-intl` (or an equivalent thin message-catalog layer — pick one, justify in progress.md) with locale files `en.json`, `hi.json`, `gu.json`. Locale is a **per-user preference** (profile + top-bar switcher), not browser-derived — shared tablets must not flip language per Chrome setting. Default `en`.
2. **Catalog extraction:** every string on the in-scope surfaces goes through the catalog — including refusal messages: extend `ERROR_MESSAGES` lookup so the shown sentence localizes while the stable code stays English in logs/audit.
3. **Translations:** seed hi/gu from the team-approved artifact's tables (they were reviewed in the mockup); flag machine-assisted entries with a `// verify` marker file for DESPL's bilingual staff to confirm. **Stage/process names are NOT translated until C27 is settled** — render them from the seed in English with the UI chrome localized around them; note this visibly in progress.md.
4. **Format handling:** dates via `Intl.DateTimeFormat(locale)`; keep numerals Latin (site convention on drawings); no string concatenation — ICU-style placeholders only.

### Gate
Language switch re-renders every in-scope surface with zero hardcoded-English leaks (grep the rendered DOM in a Playwright pass for a sentinel list of English words on hi/gu locales); layout survives longer Hindi/Gujarati strings at 390px (no overflow, no truncated buttons); en behaviour byte-identical to pre-R3.

## Session R4 — PWA, photo evidence & outbox

**Blocked until D20 (object-storage vendor) is decided — chase this before starting.**

### Tasks
1. **PWA shell:** `manifest.json` (name "DESPL Tracker", 192/512/maskable icons, `display: standalone`, `start_url: /my-day`, `theme_color #0B0C0E`, `orientation: any`), service worker caching the app shell only (no data caching, no offline writes), install prompt component. Verify installability in Chrome DevTools.
2. **Photo evidence pipeline:**
   - Shared `<PhotoCapture>`: `<input type="file" accept="image/*" capture="environment">`; client-side resize ~1600px long edge, JPEG ~0.8, strip nothing (EXIF wanted).
   - Upload via presigned URL from a new route handler (`/api/v1/evidence/presign`, actor-checked).
   - **NEW service function** `lib/services/evidence.service.ts` `attachEvidence(actor, {planId, objectKey, bytes, contentHash, exifTakenAt?, lat?, lng?, accuracyM?})` — validates the actor may act on that plan (same dept scope), writes an `Evidence` row + audit in-tx. Additive `Evidence` model in Prisma. **Invariant #1 comment at the write site: EXIF time/GPS are evidence metadata; authoritative timestamps remain the server clock.**
   - Geolocation best-effort: denied/low-accuracy → save without geo, never block submission.
   - Submit flow: photo attach is **encouraged, not required** (one confirm if missing — per the approved artifact; hard-require is a future per-process QCP flag, out of scope).
3. **Outbox (D8):** IndexedDB queue for failed submits (payload + photo blob), persistent "N updates waiting to send" banner, auto-retry on `online`/interval, server gates checked at delivery; a gate refusal at delivery returns the item to the queue UI with the refusal sentence. No conflict resolution — server is truth.
4. **Evidence display:** photo thumbnails + geo/time chips on the StageSheet/execution sheet and in the QC verify view (QC sees the evidence before verifying).

### Gate
Install on a real Android device (or emulator): standalone launch to /my-day → login persists → capture photo on an in-progress item → airplane mode → submit queues with banner → reconnect → auto-delivers → QC sees photo + chips → verify succeeds. DB suite (including new evidence tests: scope refusal, audit row, plan linkage) green twice. Lighthouse PWA installability passes.

---

## Copy-paste session prompts

> **Session R1:** Read CLAUDE.md, docs/SPEC-responsive-app-v2.md and docs/PLAN-responsive-supervisor-v1.md. First do the R0 pre-check against progress.md's Session B log. Then implement Session R1: the pointer-coarse density layer in globals.css + Tailwind coarse: variant, the ResponsiveTable primitive (adopt in /my-day and /admin Employees), the shell variants (desktop sidebar → tablet icon rail → phone bottom nav with badges; board icon = the exact approved SVG from the despl-supervisor-flow-v2 artifact), the Playwright viewport matrix (390×844, 1024×768, 1440×900) with the standard assertions, and the D27 per-user theme preference (System/Light/Dark, no-flash inline script, selector in shell + supervisor top bar, AA contrast audit of chips/tiles/charts in both palettes). No service-layer changes. Gate: all four key pages correct at all three viewports in BOTH themes via the toggle, no wrong-theme flash on hard reload, zero desktop regressions, full suite + typecheck/lint/build clean. Commit to demo; update progress.md.

> **Session R2:** Same docs; pixel reference is the approved artifact despl-supervisor-flow-v2 (described in PLAN §R2). Implement the supervisor flow: queue-first cards with do-this-first treatment and on-card Claim, full-screen execution sheet with thumb-zone pinned actions and reason-grid-first overdue flow, phone board as single column + state selector, tablet master-detail, Wake Lock during in-progress on coarse pointers, and the persisted outdoor high-contrast toggle. Reuse existing server actions — chain, never re-implement, any rule. Gate: the full-day script passes in a real browser at 390px and 1024×768; desktop unchanged; viewport suite green. Commit to demo; update progress.md.

> **Session R3:** Same docs, §R3. Add i18n for supervisor surfaces only (my-day, execution sheet, board, alerts, login, password interstitial) in en/hi/gu: message catalog, per-user locale preference with top-bar switcher, localized ERROR_MESSAGES rendering (codes stay English in logs), translations seeded from the approved artifact with // verify markers, Intl date formatting, stage names left untranslated pending C27. Gate: zero English leaks on hi/gu (sentinel grep in Playwright), no 390px overflow with longer strings, en output identical to before. Commit to demo; update progress.md.

> **Session R4:** Same docs, §R4 — confirm D20 (object storage vendor + credentials) is decided before starting; stop and ask if not. Implement the PWA shell (manifest, app-shell service worker, install prompt), the photo evidence pipeline (PhotoCapture with client resize, presigned upload via /api/v1/evidence/presign, new evidence.service.attachEvidence with additive Evidence model, geo best-effort, invariant-#1 comment), the IndexedDB outbox with visible retry banner and delivery-time gate checks, and evidence display on the execution sheet and QC verify view. Photo encouraged not required. Gate: the full on-device scenario in PLAN §R4 including airplane-mode queue/retry; new DB tests green twice; Lighthouse installability passes. Commit to demo; update progress.md.

---

## Acceptance summary (whole plan)

A supervisor installs the tracker on the workshop tablet with one tap, logs in once, and works a full day from the queue in Hindi or Gujarati: overdue items open with the reason grid and start in one motion, finished work carries a photo with geotag and time, weak WiFi queues updates visibly instead of losing them, the screen never sleeps mid-task, daylight mode is one tap, and QC sees the photo evidence before verifying — while every gate, audit row and dashboard number behaves exactly as it does on desktop, because it is the same application.

## Open inputs (chase in parallel, none block R1–R2)

- **D20** object storage vendor + budget (blocks R4)
- **C27** authoritative 25 stage names (blocks translating stage names; UI chrome translation proceeds without it)
- WhatsApp BSP choice (D26 — lands in the personal-dashboards Session D, referenced here only)
- Bilingual reviewer at DESPL for the `// verify` translation pass
