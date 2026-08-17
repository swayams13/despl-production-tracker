# SPEC — Supervisor UI v3 (design contract for Sessions R1–R2)

**Date:** 2026-08-17 · **Status:** ready to build
**Pixel reference:** `design/despl-supervisor-flow-v3.html` — open it in a browser, it is self-contained.
**Amends:** `SPEC-responsive-app-v2.md` §4 (the degradation matrix rows below now have named frames) and `PLAN-responsive-supervisor-v1.md` §R1–R2 (task lists gain frame ids). Everything else in both documents stands.
**Supersedes as pixel reference:** `design/despl-supervisor-flow-v2.html` for the supervisor surfaces only. v2 stays in the repo as history; where v2 and this file disagree, this file wins. `design/despl-tracker-mockup.html` remains the reference for every desktop surface.
**Read with:** CLAUDE.md (invariants, hard bans), DESIGN_SPEC.md (tokens, §11 rollup).

---

## 0. How to read the reference

`design/DESPL Supervisor Handoff.dc.html` is the diffable source of truth — it is readable, greppable, and what this spec's token values (§2.2) are taken from. `design/despl-supervisor-flow-v3.html` is a generated artefact (a self-extracting bundle of the same content) kept for one-click browser viewing; it is never hand-edited and never the source for a value cited in this spec — if the two ever disagree, the `.dc.html` wins and the bundle needs regenerating.

The board is organised as plates. Every frame has an id you can cite in a commit message or a review comment.

| Plate | Contents |
|---|---|
| **P0** | Assumptions, what was reconciled to the repo, what is still open |
| **P1** | Token pass — dark / light / outdoor side by side |
| **P2** | Component sheet — StatusChip, QueueCard, ActionBar, BottomNav, offline banner, wake-lock chip, each in all three themes (`P2·D` / `P2·L` / `P2·O`) |
| **P3** | Phone 390 × 844 — `P3-01` … `P3-11` |
| **P4** | Tablet 1024 × 768 landscape — `P4-01` … `P4-08` |
| **P5** | Hindi / Gujarati at 390px — `P5-01` … `P5-03` |
| **P6** | Transition table, measurement table, open decisions |

Nothing in the board is invented styling: tokens come from `src/app/globals.css` `.theme-industrial`, status values and labels from `src/components/industrial/stage-status.ts`, type from CLAUDE.md. The three exceptions are listed in §2.3 and need approval before R1 writes them.

---

## 1. Status vocabulary — one source, no per-screen wording

`stage-status.ts` is canonical: `complete · progress · submitted · hold · overdue · idle`, labelled **Complete · In progress · Awaiting QC · On hold · Overdue · Not started**.

The earlier supervisor brief used floor wording ("Ready", "With QC", "Hold", "Done"). The board uses the canonical labels instead — per CLAUDE.md's ban on raw or divergent enums in the UI. If DESPL wants floor wording, change the `label` field in `stage-status.ts` once; every surface (desktop included) follows. **Do not localise the vocabulary per screen.**

Board filter chips are therefore: `Not started · In progress · Awaiting QC · On hold · Complete`, with counts inside the chip.

---

## 2. Token layer (Session R1, task 6 — see §9's renumbered task list)

### 2.1 One addition to the existing block

```css
.theme-industrial {
  /* … existing tokens unchanged … */
  --muted-2: #5d646d;        /* third text level: mono meta, section labels */
  --accent-fg: #000;         /* names what .btn-accent already hardcodes */
  --mixp: 18%;                /* chip fill mix % — dark 18 / light 12 / outdoor 0 */
  --bordp: 45%;                /* chip border mix % — dark 45 / light 40 / outdoor 100 */
  --border-width: 1px;         /* dark + light default; outdoor overrides to 2px */
  --wb: 400;                   /* body weight — dark/light 400, outdoor 500 */
  --wt: 600;                   /* title weight — dark/light 600, outdoor 700 */
}
```

Two tokens alone (`--muted-2`, `--accent-fg`) don't express everything the
board actually renders per theme — `--mixp`/`--bordp` (chip fill/border mix,
§2.3 item 3's chip contract), `--border-width`, and `--wb`/`--wt` (the body
400→500 / title 600→700 weight steps this section's prose already names but
didn't give tokens for) are needed too. Values taken verbatim from the
board's own `themes` map (`design/DESPL Supervisor Handoff.dc.html`).

### 2.2 Light and outdoor palettes

Both are token blocks that override the same names — never filters, never per-component branching. `.theme-outdoor` wins over `.theme-light` while active and is removed on exit (D25 ⟂ D27).

```css
.theme-industrial.theme-light {
  --bg: #edeff2; --surface: #ffffff; --surface-2: #f4f6f8; --border: #d3d8de;
  --text: #10141a; --muted: #4e5a65; --muted-2: #78848f;
  --accent: #d9600a; --accent-fg: #ffffff;
  --s-idle: #6b7480; --s-progress: #2c62d6; --s-submitted: #6e3fd1;
  --s-hold: #9a6c05; --s-overdue: #c23a26; --s-complete: #1f7d4c;
  --mixp: 12%; --bordp: 40%; --wb: 400; --wt: 600;
}
.theme-industrial.theme-outdoor {
  --bg: #000; --surface: #000; --surface-2: #0c0f12; --border: #7c8b99;
  --text: #fff; --muted: #d6dee5; --muted-2: #aeb9c2;
  --accent: #ff9a4d; --accent-fg: #000;
  --s-idle: #9aa3ac; --s-progress: #8fb6ff; --s-submitted: #c9a8ff;
  --s-hold: #ffd24d; --s-overdue: #ff8b7a; --s-complete: #5be08f;
  --border-width: 2px;       /* dark/light default 1px */
  --mixp: 0%; --bordp: 100%; --wb: 500; --wt: 700;
}
```

Outdoor's three real deltas, visible in `P2·O` and required: surfaces collapse to true black so the panel edge is the only boundary; borders double to 2px; body weight steps 400→500 and titles 600→700. Chip fills go to 0% so the border carries the hue at full strength.

**This CSS block is authoritative.** The board's own interactive Dark→Light→Outdoor cycler (`design/DESPL Supervisor Handoff.dc.html`, the `themes` object) is a rendering of these values for browser preview, not a second source — where the two ever disagree, this block wins and the board gets corrected to match, never the reverse. (This happened once, 17 Aug 2026: the board's `themes` object had drifted on four values — Light and Outdoor each collapsed `--s-hold`/`--s-overdue` to one shared hex, Dark's `--s-progress` held the accent color instead of its own, and Dark/Light's `--accent-fg` didn't match either — all four corrected against this block; see progress.md.)

### 2.3 Approved 17 Aug 2026 (§P6) — was "needs approval before it is written"

1. `--muted-2` — a third text level. The board uses it for every mono meta line; without it those lines sit at `--muted` and the hierarchy flattens. (D28)
2. The light and outdoor palettes above. v1 is dark-only today; D27 and D25 require both. (D28)
3. **An icon inside `.chip` on `pointer: coarse`.** The desktop chip is pill + dot + word. A 5px dot is not a shape a gloved supervisor reads in daylight, so on coarse pointers the chip renders `icon + word` (dot dropped, same pill, same tint). Desktop chips are untouched. This keeps CLAUDE.md's "status is never colour alone" true under conditions the desktop rule was not written for. (D28)

---

## 3. Component contract

| Component | File | Frames | Notes |
|---|---|---|---|
| `StatusChip` | `src/components/industrial/status-chip.tsx` | `P2` all themes | Add the coarse-pointer icon variant (§2.3). 28px desktop/EN, 30px min-height for HI/GU. Never a target. |
| `QueueCard` | new — `src/components/industrial/queue-card.tsx` | `P3-03`, `P3-04`, `P4-02` | One action per card, always the bottom-most element. Rank 1 gets the accent frame + "DO THIS FIRST" ribbon; ranks 2+ drop both. Pool variant's action is `Claim` (outline). |
| `ExecActionBar` | new — `src/components/industrial/exec-action-bar.tsx` | `P2` (4 states), `P3-05…08`, `P4-04…06` | 56px controls, 8px gutter, pinned to the bottom of its own container. Disabled states state their own gate in the label; they are never hidden. |
| `SupervisorNav` | extend `src/components/industrial/app-shell.tsx` | `P2`, every `P3`/`P4` frame | Phone: bottom nav 64px + safe-area inset. Tablet: 76px icon rail. Same four destinations, same badge, theme cycle at the rail's bottom / top bar on phone. |
| `StageSpine` (strip) | `src/components/industrial/stage-spine.tsx` | header of every execution frame | Reuse as-is with a compact prop: 9px segments on phone, 12px on tablet, `--s-*` fill + existing overdue/rejected pips. Do not fork it. |
| Offline queue banner | new — part of the R4 outbox, drawn here | `P2`, `P3-03`, `P5-01` | Sits above the queue, never over a target. 48px Retry. |
| Wake-lock chip | new | `P2`, `P3-06`, `P4-02` | Present only while an item is in progress on a coarse pointer. Absent, not disabled, where unsupported. |

`app-shell.tsx`, `stage-spine.tsx`, `status-chip.tsx` and `stage-sheet.tsx` already exist — **extend them, do not create parallel supervisor copies.** A second shell is how the two-UI problem SPEC-responsive-app-v2 §1 rejected creeps back in.

---

## 4. Screen contract

| Route | Phone | Tablet | What changes |
|---|---|---|---|
| `/login` | `P3-01` | `P4-01` | Two-column on tablet so nothing sits under the landscape keyboard. **Username or email** + password (D13, shipped `2a2dc27`; the field label is literally "Username or email" — `e2e/auth.spec.ts:21` asserts it via `getByLabel`, not "Email"), language picked before login and stored per user. Frames `P3-01`/`P4-01` need this same corrected wording, not "Email + password." |
| `/account/password` | `P3-02` | same split as `P4-01` | Gate: no nav, no back. Button enables only when all three rules pass. |
| `/my-day` | `P3-03`, `P3-04` | `P4-02` | Phone: mine-first cards, scoreboard as a summary line expanding to 2 × 2. Tablet: master-detail, scoreboard always the 2 × 2 grid, execution panel on the right. |
| execution sheet | `P3-05` overdue · `P3-06` in progress · `P3-07` hold · `P3-08` submitted | `P4-04` · `P4-02` · `P4-05` · `P4-06` | Full-screen below 640px; the detail panel (556 × 712) inside `/my-day` and the board above it. Reason grid is 2 × 3 on phone, 3 × 2 on tablet. |
| `/board` | `P3-09` | `P4-03` | Phone: one column + scrolling filter chips. Tablet: list left (440px) / same execution panel right; chips wrap to two rows so all five are reachable. |
| `/alerts` | `P3-10` | `P4-07` | Tablet gains a detail side because a rejection carries a sentence that gets skipped in a list row. |
| `/profile` | `P3-11` | `P4-08` | Language list (each option in its own script), theme 3-up, device block including wake-lock support and queued-update count. |

**Routes (D31):** `/board`, `/alerts`, `/profile` are three new routes under the `(app)` route group, matching `/my-day`'s pattern. `src/middleware.ts` is deny-by-default with a catch-all matcher (`matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"]` over a `PUBLIC_PATHS` allowlist of just `/login` and `/api/health`) — new routes are protected automatically; no middleware change is needed.

---

## 5. Measurements (assert these)

**Scope: `pointer: coarse`, not a route list.** Every row below applies where
`pointer: coarse` matches — the same axis Task 1's density layer already
keys off (SPEC-responsive-app-v2 §3.1) — not to a fixed set of "supervisor
routes." Applied unconditionally these would regress desktop: `.chip` is
~19px today, and 28px would fatten every 36px table row across the whole
app, contradicting this section's own §5 chip-height intent, which is a
coarse-pointer floor, not a global resize. Desktop (`pointer: fine`) stays
6/4 radii and 13px body, unchanged, everywhere — including on `/board`,
`/alerts`, `/profile` if ever opened with a mouse. "Supervisor surfaces" in
this spec means "rendered on a coarse pointer," not "these specific routes."

| | |
|---|---|
| Primary action height | 56 |
| Any other tappable | 48 |
| Gap between adjacent targets | ≥ 8 |
| Bottom nav (EN / HI-GU) | 64 / 68 |
| Status chip (EN / HI-GU) | 28 / 30 |
| Phone gutter | 14 |
| Tablet rail | 76 |
| Tablet queue column | 392 (board list 440) |
| Card radius / control radius | 12 / 10 on supervisor surfaces (desktop stays 6 / 4) |
| Outdoor border width | 2 |
| Body text floor on coarse | 15 |
| Indic line-height floor | 1.45 |

Reason-grid cells: 66px phone EN, 78px phone HI/GU, 80px tablet. Every text container on a localisable string is `min-height`, never `height` — the one defect this board was rebuilt to avoid.

---

## 6. Transitions → the actions they call

Reuse existing server actions; chain them, never re-implement a rule (CLAUDE.md invariants #1–#12 apply unchanged). Verify the exported names before wiring.

| Transition | Calls |
|---|---|
| Sign in → forced change or `/my-day` | `actions/auth.ts` |
| Password set | `actions/account.ts` |
| Claim (pool → mine) | `actions/assignment.ts` — optimistic, no dialog; failure returns the card to POOL with the refusal sentence |
| Reason select → unlock primary | client only |
| **File reason & start** | `actions/delay.ts` then `actions/process.ts` start, chained server-side, one motion, no confirm |
| Submit finish | `actions/process.ts` submit → optimistic **Awaiting QC**, wake lock releases, sheet becomes read-only |
| Nudge QC | `actions/notifications.ts` — notify QC + production head with hold age, write the trail row, disable 30 min |
| QC verify / reject | existing QC surfaces; reject returns the item to the queue at rank 1 with a rejection banner |
| Theme cycle | root class only, persisted per user |

Gates stay server-side. Every disabled control in the board corresponds to a real refusal code (`GATING_BLOCKED`, `REASON_REQUIRED`, `HOLD_POINT_OPEN`, `MAKER_CHECKER_VIOLATION`) and must show that refusal's sentence, localised, with the code unchanged in the log.

**Three clarifications:**

(a) **`nudgeQc` does not exist yet.** `src/lib/services/notifications.service.ts` has no function by that name today — it is new work for R2 (D32), a service function alongside the existing `notify`/`userIdsWithRole`/`markNotificationRead`/`markAllNotificationsRead`/`syncNotifications`. The "disable 30 min" cooldown in the table above is **derived server-side** from the last NUDGE-type `Notification` row for that plan + actor — never client state (a client-held timer resets on refresh/device-switch and a supervisor could nudge repeatedly by reloading; the server row is the only source that survives both).

(b) **"File reason & start" can legitimately half-succeed.** The reason file and the start are chained server-side, but the start half can still be refused by gating (invariant #7's own point: a categorized reason clears the *delay* block, it does not bypass sequential gating or a hold point) — this is correct behavior, not a bug to design around. When that happens: the reason has filed, the sheet stays open, the reason grid collapses to show the now-filed reason, and the primary action re-labels to plain **"Start"** (the reason step is done; only the start remains, and it now shows its own refusal if it fails again).

(c) **Every supervisor-surface action must revalidate `/my-day` and `/board`, not just `/workspace`/`/dashboard`.** Checked directly: `src/app/actions/process.ts`, `delay.ts`, and `assignment.ts` all call `revalidatePath("/workspace")` and `revalidatePath("/dashboard")` today, and none call `revalidatePath("/my-day")` or `revalidatePath("/board")` — meaning a supervisor's own action wouldn't reliably refresh the surfaces this spec puts it on. Every server action reachable from a supervisor surface needs both new paths added alongside the existing two, not in place of them (desktop still reads `/workspace`/`/dashboard`).

---

## 7. i18n rules (Session R3, designed here)

- Chrome localises; **process and stage names stay English** (C27 unresolved) — `P5-01` shows exactly that mixed-script case.
- Numerals, job codes, unit serials, ITP refs, WPS refs stay Latin.
- Weekday localises, month code stays Latin.
- One ICU message per sentence; no concatenation. The bolded clause in `P5-02`'s banner is a placeholder inside one message.
- Two components change measurement across locales: nav height and chip height (`P5-03`). If a locale needs a third, the string is too long — shorten the translation, do not shrink the type.
- Longest string in the app is the overdue primary action. It gets a two-line allowance rather than an ellipsis; a truncated action label is worse than a taller button.

---

## 8. Playwright viewport matrix (R1, task 7 — see §9's renumbered task list)

`playwright.config.ts` currently has one project (`chromium`, Desktop Chrome). Add:

```ts
projects: [
  { name: 'phone',   use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 }, hasTouch: true } },
  { name: 'tablet',  use: { ...devices['Galaxy Tab S4 landscape'], viewport: { width: 1024, height: 768 }, hasTouch: true } },
  { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
]
```

Per supervisor page, assert:

1. No horizontal overflow at 390 (`scrollWidth <= clientWidth`).
2. Every interactive element ≥ 48 × 48 on the touch projects; every element marked primary ≥ 56 high.
3. Adjacent targets ≥ 8px apart.
4. The primary action is inside the bottom third of the viewport without scrolling.
5. The §4 degradation actually happened: board is one column at 390 and two panes at 1024; execution sheet is full-screen at 390 and a panel at 1024; scoreboard is a summary line at 390 and a 2 × 2 grid at 1024.
6. All three themes hold AA on chips, KPI values and the spine (run the contrast check per theme class, not once).
7. `hi` and `gu` locales: no overflow at 390, no clipped button text, and no sentinel English word on a localised surface.

**This is three tasks, not one — all needed before the assertions above are runnable at all:**

1. **A real `/login` storageState fixture per project.** `playwright.config.ts` currently has one project (`chromium`) and `e2e/auth.spec.ts` drives the actual login form directly. The three new projects (`phone`/`tablet`/`desktop`) need their own authenticated fixture — CLAUDE.md's "Agent conduct" section forbids forging a session from `AUTH_SECRET` (the 16 Aug portfolio-dashboard incident), so this fixture must drive the real `/login` form once per project and save `storageState`, the same pattern `auth.spec.ts` already establishes, not a hand-built cookie/JWT.
2. **`testMatch` scoping.** Without it, adding the three viewport projects would run *every* existing spec (including `auth.spec.ts`) three more times each. Scope `phone`/`tablet`/`desktop` to `testMatch` the new supervisor-surface specs only; `auth.spec.ts` stays on a single project (`chromium`/`desktop`) as today.
3. **A WCAG contrast helper.** Checked: no contrast/WCAG utility exists anywhere in `e2e/` or `src/` today (assertion 6 above has nothing to call). Needs a small helper computing relative luminance + contrast ratio from computed `color`/`background-color`, run per theme class per the assertion above.

**Device registry caution, verified 17 Aug 2026:** `devices['Galaxy Tab S4 landscape']` must be checked against the installed Playwright version's device registry before the config is written — an unknown key throws at config load, not at test run, so a typo here breaks every project, not just the new ones. Verified directly against this repo's installed `playwright-core@1.62.1` (`grep -o '"Galaxy Tab[^"]*"' .../coreBundle.js`): the key exists verbatim (`"Galaxy Tab S4 landscape"`, alongside `"Galaxy Tab S4"`, `"Galaxy Tab S9 landscape"`, `"Galaxy Tab S9"`) — safe to use as written above. Re-verify if the Playwright version ever bumps.

**`webServer.command` must become `pnpm build && pnpm start`, not `pnpm dev`.** The current config runs the dev server (`pnpm dev`, Turbopack) under Playwright; a three-viewport-project matrix multiplies test count and dev-mode's slower first-paint/recompile behavior turns into flaky timing failures at scale. Build once, serve the production build, matching how CI actually deploys.

---

## 9. Session amendments

**R1 — foundation + shell. Task list replaced (was 5 tasks, now 7)** — the
original 5 stand, reordered and two split out where v3 adds real new-build
scope (D28's coarse-pointer chip icon is component code, not just tokens;
D31 is three routes that didn't exist before), rather than folding
everything into the original Task 3/Task 5 slots:

1. Density layer (`pointer: coarse` + Tailwind `coarse:`/`fine:` variants) — **done**, unchanged by this amendment.
2. `<ResponsiveTable>` primitive + adoption in `/my-day` and `/admin` Employees — unchanged by this amendment.
3. `/board`, `/alerts`, `/profile` route shells (D31) — new. Minimal `page.tsx` per route under `(app)`, deny-by-default already covered by `middleware.ts`'s catch-all matcher (no middleware change). Full page content is R2; R1 only needs these to exist and be reachable so the shell's nav destinations resolve.
4. Shell variants: extend `app-shell.tsx` with the phone bottom nav (64px + safe-area inset) and tablet icon rail (76px) per `P2`/`P4`, linking to Task 3's routes; board glyph SVG copied verbatim from the v3 board reference (supersedes the v2 artifact as the SVG source, per this spec's §0); theme-cycle control placed at the rail's bottom (tablet) / top bar (phone).
5. `StatusChip` coarse-pointer icon variant (§2.3 item 3, D28) — `icon + word` replacing `dot + word` on `pointer: coarse`, same pill, same tint; desktop untouched. Isolated as its own task because `status-chip.tsx` is used everywhere in the app, not just supervisor surfaces — its own review, not folded into the token-layer task.
6. Token layer + theme preference (§2 exactly as given, D27/D28): `--muted-2`/`--accent-fg`/`--mixp`/`--bordp`/`--border-width`/`--wb`/`--wt` on the base block, `.theme-light`/`.theme-outdoor` overrides, the System/Light/Dark selector (D27) with a working Outdoor toggle (D25 — the mechanism, not R2's full shop-floor UX) driven by a no-flash pre-hydration script, one selector in the shell (per the earlier "supervisor top bar" ruling — `AppShell`'s `.topbar`), and the AA contrast audit across all three themes including Task 5's now-finished chip icon variant.
7. Playwright viewport matrix (§8): the three projects, the real-`/login`-driven `storageState` fixture per project (never a forged session — CLAUDE.md), `testMatch` scoping so `auth.spec.ts` stays single-project, the WCAG contrast helper, and `webServer.command` changed to `pnpm build && pnpm start`.

**Three new gate conditions**, added to the original R1 gate (all still apply: `/dashboard`, `/workspace`, `/my-day`, `/admin` correct at all three viewports, zero desktop regressions, full suite + typecheck/lint/build clean):

- All three viewports correct in all **three** themes — dark, light, **and outdoor** — via the toggle (was two themes in PLAN v1's original gate).
- `/board`, `/alerts`, `/profile` exist as protected routes (a bare unauthenticated request redirects, matching the app's existing pattern) and are reachable with no dead link from every shell variant — desktop sidebar, tablet rail, phone bottom nav.
- The Playwright viewport-matrix suite passes end-to-end with its real-login fixture and `testMatch` scoping in place, including the per-theme AA contrast assertion (§8 assertion 6) — not just "the file exists and typechecks."

**R2 — supervisor flow.** Build to the frames named in §4. Gate: the full-day script passes at 390 and 1024 × 768 — overdue → reason → start; in-progress → photo → submit; claim from pool; hold locked + nudge; board single column; theme cycle through outdoor — plus the §5 measurements asserted and desktop `/my-day` unchanged at 1440.

**R3 / R4** — unchanged; §7 is R3's design input, and the offline banner and wake-lock chip drawn in `P2` are R4's and R2's respectively.

---

## 10. Decisions this file opens

| # | Decision | Status |
|---|---|---|
| D28 | `--muted-2`, light + outdoor palettes, coarse-pointer chip icon added to `.theme-industrial` | **approved (17 Aug 2026)** — §2.3 |
| D29 | Canonical status labels used on supervisor surfaces; floor wording, if wanted, changes `stage-status.ts` globally | **approved (17 Aug 2026)** |
| D30 | Supervisor surfaces use 12 / 10 radii and 15px body on coarse pointers while desktop keeps 6 / 4 and 13px | **approved (17 Aug 2026)** |
| D31 | Three new routes — `/board`, `/alerts`, `/profile` — under the `(app)` route group; no middleware change (existing catch-all matcher covers them) | **approved (17 Aug 2026)** — §4 |
| D32 | `nudgeQc()` is new work in `notifications.service.ts` (R2); 30-min cooldown derived server-side from the last NUDGE `Notification` row, never client state | **approved (17 Aug 2026)** — §6(a) |
| C27 | 25 stage names — sheet shows the **process** name with stage n/25 in the chip, which is correct either way (§11.3) | still open, not blocking |
