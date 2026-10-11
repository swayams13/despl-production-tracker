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

1. CLAUDE.md invariants #1–#12; rules stay in `lib/services/` — **no session in this plan touches services except R4's photo-evidence write** (one new service function, specced below) **and R2's `nudgeQc()` in `notifications.service.ts`** (D32, SPEC-supervisor-ui-v3.md §6(a) — the 30-min cooldown is derived server-side from the last NUDGE-type `Notification` row, never client state).
2. SPEC-responsive-app-v2 §3.2 touch standard is a hard gate: ≥48px interactive targets on `pointer: coarse`, 56px primary shop-floor actions, ≥8px spacing.
3. SPEC §4 degradation matrix is the contract; any surface not in the matrix gets an explicit behaviour decision before it ships.
4. No hover-only affordances; status = colour + icon + word; no raw enums in UI (hard bans — grep before commit).
5. Existing desktop layouts must not regress: every session re-verifies `/dashboard`, `/workspace`, `/my-day` at 1440px, light + dark.

## Viewport test matrix (added in R1, run in every session after)

Playwright projects: `390×844` (phone), `1024×768` (tablet landscape — primary shop-floor device), `1440×900` (desktop). Assertions per page: no horizontal overflow at 390; all interactive elements ≥48px on coarse; primary action visible without scrolling on phone; the specific §4 degradation happened (board = 1 column at 390, tables = cards, exec sheet = full-screen with pinned bottom bar).

---

## Session R1 — Responsive foundation + shell

**Task list amended 17 Aug 2026 by SPEC-supervisor-ui-v3.md §9 (read that file
first — it is the current contract for this session; this list mirrors it).
Was 5 tasks, now 7: the original 5 stand, reordered, with two new tasks
split out where v3 adds real new-build scope that doesn't belong folded into
an existing task (D28's coarse-pointer chip icon is component code touching
a file used everywhere in the app, not just a token; D31 is three routes
that didn't exist before).**

### Tasks
1. **Density layer** in `globals.css` inside `.theme-industrial`: on `@media (pointer: coarse)` raise base font to 15px, control min-height to 48px, row padding ~+40%. Add Tailwind `coarse:`/`fine:` variants. No per-component branching — components inherit. **Done** (commits `57c782a`..`5df8501`).
2. **`<ResponsiveTable>` primitive** (`components/industrial/responsive-table.tsx`): real table ≥1024px, card list below. Adopt it in `/my-day` and `/admin` Employees (the two highest-traffic tables) this session; other tables migrate opportunistically.
3. **`/board`, `/alerts`, `/profile` route shells (D31) — new.** Minimal `page.tsx` per route under `(app)`; `src/middleware.ts`'s existing catch-all matcher already deny-by-default protects them, no middleware change needed. Full page content is R2 — R1 only needs these to exist and be reachable so Task 4's nav destinations resolve to something real, not a 404.
4. **Shell variants:** desktop sidebar (unchanged) → tablet icon rail (76px) → phone bottom nav (64px + safe-area inset; Today · Board · Alerts · Profile) with badge counts, linking to Task 3's routes. Top bar on phone: title + bell only. Board icon is the framed glyph with bottom-aligned rising bars, small bar left / big bar right — copy the exact SVG from the **v3** board reference (`design/DESPL Supervisor Handoff.dc.html` — supersedes the v2 artifact as the SVG source per SPEC-supervisor-ui-v3.md §0). Theme-cycle control (Task 6) placed at the rail's bottom (tablet) / top bar (phone).
5. **`StatusChip` coarse-pointer icon variant (D28) — new.** `icon + word` replaces `dot + word` on `pointer: coarse` (same pill, same tint); desktop chip untouched. Isolated as its own task, not folded into Task 6, because `status-chip.tsx` is used across the whole app — its own review, given the blast radius.
6. **Token layer + theme preference (D27/D28):** write SPEC-supervisor-ui-v3.md §2 exactly as given — `--muted-2`/`--accent-fg`/`--mixp`/`--bordp`/`--border-width`/`--wb`/`--wt` on the base `.theme-industrial` block, plus `.theme-light`/`.theme-outdoor` override blocks (exact hex values in the spec, sourced from the approved v3 board — not invented). Three-way System / Light / Dark selector (D27), stored per user, one selector in the shell's shared topbar (desktop and supervisor surfaces render the same `AppShell`, so one control serves both — see the SDD ledger's ruling on this), applied as a root class by an inline pre-hydration script (no wrong-theme flash), plus a working Outdoor toggle (D25 — the on/off mechanism only; R2 owns outdoor's full shop-floor UX). Audit that status chips (including Task 5's new coarse-icon variant), KPI tiles and charts hold AA contrast in **all three** palettes.
7. **Playwright viewport matrix** (SPEC-supervisor-ui-v3.md §8): the three projects (phone 390×844, tablet 1024×768, desktop 1440×900) wired into the standard test run, plus a real-`/login`-driven `storageState` fixture per project (never a forged session — CLAUDE.md's Agent Conduct section), `testMatch` scoping so `auth.spec.ts` stays single-project, a new WCAG contrast helper (none exists today), and `webServer.command` changed to `pnpm build && pnpm start` (not `pnpm dev` — a 3x project matrix under dev-mode Turbopack is flaky at this scale). Verify `devices['Galaxy Tab S4 landscape']` against the installed Playwright version's device registry before writing the config (confirmed present in this repo's `playwright-core@1.62.1` as of 17 Aug 2026 — re-verify on any version bump).

### Gate
`/dashboard`, `/workspace`, `/my-day`, `/admin` render correctly at all three viewports **in all three themes via the new toggle** (dark, light, **and outdoor** — not just OS preference, and not just two themes); no flash-of-wrong-theme on hard reload; viewport suite green (including the per-theme AA contrast assertion, not just "the file exists"); zero desktop regressions; full suite + typecheck/lint/build clean.

**Three gate conditions added 17 Aug 2026 (SPEC-supervisor-ui-v3.md §9):**
- All three viewports correct in all three themes via the toggle (supersedes the original "both themes" wording above — now folded into it).
- `/board`, `/alerts`, `/profile` exist as protected routes (a bare unauthenticated request redirects, matching the app's existing pattern) and are reachable with no dead link from every shell variant — desktop sidebar, tablet rail, phone bottom nav.
- The Playwright viewport-matrix suite passes end-to-end with its real-login fixture and `testMatch` scoping in place, including the per-theme AA contrast assertion — not just "the file exists and typechecks."

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

> **Session R1 (amended 17 Aug 2026):** Read CLAUDE.md, docs/SPEC-responsive-app-v2.md, docs/SPEC-supervisor-ui-v3.md, and docs/PLAN-responsive-supervisor-v1.md — v3 is the current design contract for R1/R2 and wins where it disagrees with anything older. First do the R0 pre-check against progress.md's Session B log (already done, 17 Aug — see progress.md; Session B shipped desktop-only, R1 builds all 7 tasks). Then implement Session R1's 7 tasks: the pointer-coarse density layer (done), the ResponsiveTable primitive (adopt in /my-day and /admin Employees), the /board + /alerts + /profile route shells (D31), the shell variants (desktop sidebar → tablet icon rail → phone bottom nav with badges; board icon = the exact SVG from design/DESPL Supervisor Handoff.dc.html, the v3 board — not the v2 artifact), the StatusChip coarse-pointer icon variant (D28), the token layer + D27/D28 theme preference (System/Light/Dark plus a working Outdoor toggle, no-flash inline script, one selector in the shared AppShell topbar, AA contrast audit of chips/tiles/charts in all three palettes), and the Playwright viewport matrix (390×844, 1024×768, 1440×900) with its real-login storageState fixture, testMatch scoping, WCAG contrast helper, and build+start webServer. No service-layer changes. Gate: all four key pages correct at all three viewports in ALL THREE themes via the toggle, no wrong-theme flash on hard reload, the three new routes exist and are reachable with no dead link, the viewport suite passes end-to-end (including the AA assertion), zero desktop regressions, full suite + typecheck/lint/build clean. Commit to demo; update progress.md.

> **Session R2:** Same docs — SPEC-supervisor-ui-v3.md §4/§5/§6 (frame ids P3-05..11, P4-02..08) supersedes PLAN §R2's original prose where they disagree; pixel reference is the v3 board (design/DESPL Supervisor Handoff.dc.html / design/despl-supervisor-flow-v3.html), not the v2 artifact. Implement the supervisor flow: queue-first cards with do-this-first treatment and on-card Claim, full-screen execution sheet with thumb-zone pinned actions and reason-grid-first overdue flow (including the legitimate File-reason-&-start partial-success case, SPEC v3 §6(b)), phone board as single column + state selector, tablet master-detail, Wake Lock during in-progress on coarse pointers, the persisted outdoor high-contrast toggle's full shop-floor UX, and nudgeQc() (D32, new service function in notifications.service.ts — server-derived 30-min cooldown from the last NUDGE Notification row). Also add /my-day and /board to the revalidatePath calls in actions/process.ts, delay.ts and assignment.ts (SPEC v3 §6(c) — neither is revalidated today, only /workspace and /dashboard). Reuse existing server actions — chain, never re-implement, any rule. Gate: the full-day script passes in a real browser at 390px and 1024×768; desktop unchanged; viewport suite green; the SPEC v3 §5 measurement table holds on `pointer: coarse` (desktop unaffected, per §5's scoping note).

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
