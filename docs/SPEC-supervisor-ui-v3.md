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

## 2. Token layer (Session R1, task 1)

### 2.1 One addition to the existing block

```css
.theme-industrial {
  /* … existing tokens unchanged … */
  --muted-2: #5d646d;        /* third text level: mono meta, section labels */
  --accent-fg: #000;         /* names what .btn-accent already hardcodes */
}
```

### 2.2 Light and outdoor palettes

Both are token blocks that override the same names — never filters, never per-component branching. `.theme-outdoor` wins over `.theme-light` while active and is removed on exit (D25 ⟂ D27).

```css
.theme-industrial.theme-light {
  --bg: #edeff2; --surface: #ffffff; --surface-2: #f4f6f8; --border: #d3d8de;
  --text: #10141a; --muted: #4e5a65; --muted-2: #78848f;
  --accent: #d9600a; --accent-fg: #ffffff;
  --s-idle: #6b7480; --s-progress: #2c62d6; --s-submitted: #6e3fd1;
  --s-hold: #9a6c05; --s-overdue: #c23a26; --s-complete: #1f7d4c;
}
.theme-industrial.theme-outdoor {
  --bg: #000; --surface: #000; --surface-2: #0c0f12; --border: #7c8b99;
  --text: #fff; --muted: #d6dee5; --muted-2: #aeb9c2;
  --accent: #ff9a4d; --accent-fg: #000;
  --s-idle: #9aa3ac; --s-progress: #8fb6ff; --s-submitted: #c9a8ff;
  --s-hold: #ffd24d; --s-overdue: #ff8b7a; --s-complete: #5be08f;
  --border-width: 2px;       /* dark/light default 1px */
}
```

Outdoor's three real deltas, visible in `P2·O` and required: surfaces collapse to true black so the panel edge is the only boundary; borders double to 2px; body weight steps 400→500 and titles 600→700. Chip fills go to 0% so the border carries the hue at full strength.

**This CSS block is authoritative.** The board's own interactive Dark→Light→Outdoor cycler (`design/DESPL Supervisor Handoff.dc.html`, the `themes` object) is a rendering of these values for browser preview, not a second source — where the two ever disagree, this block wins and the board gets corrected to match, never the reverse. (This happened once, 17 Aug 2026: the board's `themes` object had drifted on four values — Light and Outdoor each collapsed `--s-hold`/`--s-overdue` to one shared hex, Dark's `--s-progress` held the accent color instead of its own, and Dark/Light's `--accent-fg` didn't match either — all four corrected against this block; see progress.md.)

### 2.3 Needs approval before it is written (§P6)

1. `--muted-2` — a third text level. The board uses it for every mono meta line; without it those lines sit at `--muted` and the hierarchy flattens.
2. The light and outdoor palettes above. v1 is dark-only today; D27 and D25 require both.
3. **An icon inside `.chip` on `pointer: coarse`.** The desktop chip is pill + dot + word. A 5px dot is not a shape a gloved supervisor reads in daylight, so on coarse pointers the chip renders `icon + word` (dot dropped, same pill, same tint). Desktop chips are untouched. This keeps CLAUDE.md's "status is never colour alone" true under conditions the desktop rule was not written for.

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
| `/login` | `P3-01` | `P4-01` | Two-column on tablet so nothing sits under the landscape keyboard. Email + password (matches `src/app/actions/auth.ts`), language picked before login and stored per user. |
| `/account/password` | `P3-02` | same split as `P4-01` | Gate: no nav, no back. Button enables only when all three rules pass. |
| `/my-day` | `P3-03`, `P3-04` | `P4-02` | Phone: mine-first cards, scoreboard as a summary line expanding to 2 × 2. Tablet: master-detail, scoreboard always the 2 × 2 grid, execution panel on the right. |
| execution sheet | `P3-05` overdue · `P3-06` in progress · `P3-07` hold · `P3-08` submitted | `P4-04` · `P4-02` · `P4-05` · `P4-06` | Full-screen below 640px; the detail panel (556 × 712) inside `/my-day` and the board above it. Reason grid is 2 × 3 on phone, 3 × 2 on tablet. |
| board | `P3-09` | `P4-03` | Phone: one column + scrolling filter chips. Tablet: list left (440px) / same execution panel right; chips wrap to two rows so all five are reachable. |
| alerts | `P3-10` | `P4-07` | Tablet gains a detail side because a rejection carries a sentence that gets skipped in a list row. |
| profile | `P3-11` | `P4-08` | Language list (each option in its own script), theme 3-up, device block including wake-lock support and queued-update count. |

---

## 5. Measurements (assert these)

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

---

## 7. i18n rules (Session R3, designed here)

- Chrome localises; **process and stage names stay English** (C27 unresolved) — `P5-01` shows exactly that mixed-script case.
- Numerals, job codes, unit serials, ITP refs, WPS refs stay Latin.
- Weekday localises, month code stays Latin.
- One ICU message per sentence; no concatenation. The bolded clause in `P5-02`'s banner is a placeholder inside one message.
- Two components change measurement across locales: nav height and chip height (`P5-03`). If a locale needs a third, the string is too long — shorten the translation, do not shrink the type.
- Longest string in the app is the overdue primary action. It gets a two-line allowance rather than an ellipsis; a truncated action label is worse than a taller button.

---

## 8. Playwright viewport matrix (R1, task 4)

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

---

## 9. Session amendments

**R1 — foundation + shell.** Unchanged tasks, plus: write §2 exactly as given; extend `app-shell.tsx` with the phone bottom nav and tablet rail per `P2` and any `P4` frame (the board glyph SVG is in the reference — copy it, it is the approved framed-bars form); add the §8 matrix. Gate additionally: `/dashboard`, `/workspace`, `/my-day`, `/admin` correct at all three viewports in all **three** themes via the toggle, no wrong-theme flash, zero desktop regressions.

**R2 — supervisor flow.** Build to the frames named in §4. Gate: the full-day script passes at 390 and 1024 × 768 — overdue → reason → start; in-progress → photo → submit; claim from pool; hold locked + nudge; board single column; theme cycle through outdoor — plus the §5 measurements asserted and desktop `/my-day` unchanged at 1440.

**R3 / R4** — unchanged; §7 is R3's design input, and the offline banner and wake-lock chip drawn in `P2` are R4's and R2's respectively.

---

## 10. Decisions this file opens

| # | Decision | Status |
|---|---|---|
| D28 | `--muted-2`, light + outdoor palettes, coarse-pointer chip icon added to `.theme-industrial` | proposed — §2.3 |
| D29 | Canonical status labels used on supervisor surfaces; floor wording, if wanted, changes `stage-status.ts` globally | proposed |
| D30 | Supervisor surfaces use 12 / 10 radii and 15px body on coarse pointers while desktop keeps 6 / 4 and 13px | proposed |
| C27 | 25 stage names — sheet shows the **process** name with stage n/25 in the chip, which is correct either way (§11.3) | still open, not blocking |
