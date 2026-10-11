# AUDIT — Cross-Device Compatibility & Mobile Readiness (v1)

**Date:** 2026-08-19 · **Status:** findings, for triage
**Scope:** every finding below is anchored to a file + line in the current tree. Nothing here is speculative.
**Read with:** `docs/ADR-mobile-and-architecture-v1.md` (D17–D22), `docs/SPEC-responsive-app-v2.md`, `docs/SPEC-supervisor-ui-v3.md`

---

## 0. Executive answer

**Will different phones/tablets/resolutions/OS versions cause problems?**

The *architecture* is already right — three shell variants, CSS-only breakpoints, a coarse-pointer density layer, a `<ResponsiveTable />` primitive, and a Playwright viewport matrix. That is more responsive groundwork than most internal tools ever get. You are not facing a rewrite.

The *execution* has ~30 concrete defects, and four of them are severe enough that a supervisor or QC user handed a tablet today would be blocked from doing their job. They are all fixable in days, not weeks.

The one genuine hard limit is a **browser-engine floor**, not a resolution problem — see §3.

---

## 1. P0 — blocks real work on a real device

### 1.1 Eight of twelve routes are unreachable below 1024px

`app-shell.tsx:121` defines `SHELL_NAV` = `/my-day`, `/board`, `/alerts`, `/profile`.
`app-shell.tsx:265` renders `NAV` = `/dashboard`, `/jobs`, `/workspace`, `/departments`, `/qc`, `/welding`, `/reports`, `/admin` — **inside `.sidebar` only**.
`globals.css:733, 751` set `.sidebar { display: none }` below 1024px.

**Zero href overlap between the two lists.** On a phone and on every tablet from 640–1023px there is no link to Jobs, Workspace, QC, Welding, Reports, Departments, Dashboard or Admin.

A QC inspector on a tablet cannot navigate to `/qc`. That is the whole point of giving them a tablet.

### 1.2 Sign out is desktop-only

`app-shell.tsx:292-299` — the only logout control lives in `.sidebar`. No equivalent in `.icon-rail` (`:308`) or `.bottom-nav` (`:337`). A shared shop-floor tablet cannot be handed to the next shift.

### 1.3 A 1024px tablet gets the desktop UI

`.icon-rail` is scoped `640–1023px`; `.sidebar` returns at `min-width: 1024px`. **iPad landscape and Galaxy Tab S4 landscape are both exactly 1024px CSS.** They therefore receive the 236px desktop sidebar, real `<table>` layouts, and desktop-sized hit targets — on a touch screen.

This is already a known `test.fail` in `e2e/supervisor-viewport.spec.ts`. The root cause is that the shell switches on **width alone**; it should switch on width **and** `pointer: coarse`, which the density layer already does correctly (`globals.css:1021`).

### 1.4 `qcp-grid.tsx` has no horizontal scroll container

The 9-column QCP table (`qcp-grid.tsx:60-78`) is the only wide table in the app with no `overflow-x` wrapper — unlike `.gantt` (`globals.css:957`), `.uxs` (`:944`) and the dept matrix. Under `pointer: coarse`, `td` padding rises to `0 17px` (`:1028`) and `.btn` to 48px min-height, pushing minimum content width to ~600–700px.

Result: the QCP grid blows out its card and **puts the entire page into horizontal scroll on a phone**. This is a QCP/ITP screen — a hold-point screen — so it is the highest-consequence table in the product.

---

## 2. P1 — visibly wrong, still usable

### 2.1 Two fonts silently never load

`next/font` exposes hashed family names via `--font-inter` / `--font-jbmono`. Eight rules hardcode the literal names instead:

- `globals.css:554` `.reason-cell` — `font: 600 13px/1.3 Inter, system-ui`
- `globals.css:688` `.queue-card-title` — `font: var(--wt) 17px/1.35 Inter, system-ui`
- Six rules using `"JetBrains Mono"` — `.queue-ribbon`, `.queue-card-meta`, `.queue-scoreboard-*`, `.sh-hold-card .age`, `.queue-section-label`

`Inter` and `JetBrains Mono` are not installed on any phone, so these fall through to `system-ui` / `ui-monospace` — Roboto on Android, SF on iOS. **Every one of these is a phone-only element** (the queue card is the supervisor's primary screen), and the mono fallbacks break the tabular-nums alignment CLAUDE.md treats as non-negotiable. The same datum renders at a different width on Android vs iPhone.

### 2.2 iOS auto-zooms on every text input

`globals.css:639` sets `input.ws-detail { font-size: 12px }`, and the coarse-pointer block never raises it. iOS Safari force-zooms the viewport whenever a focused input is under 16px, and `layout.tsx:25-29` deliberately permits zoom (correctly — do not fix this by banning zoom).

Affects `/login` (`login/page.tsx:39, 51`), every delay-reason field (`my-day/_client.tsx:235, 281, 443, 476`) and `workspace/_client.tsx:96, 171, 244, 284, 316`. The page zooms in and stays scrolled after every entry.

### 2.3 `100vh` instead of `100dvh`

`globals.css:417, 418, 746`. Mobile browsers report `100vh` as the height *without* the collapsing address bar, so the sidebar and icon rail extend below the fold. Zero uses of `dvh` in the stylesheet.

### 2.4 The safe-area padding is dead code

`globals.css:778, 829` use `env(safe-area-inset-bottom)` — correct intent. But `env()` returns `0` unless the viewport declares `viewport-fit: cover`, and `src/app/layout.tsx:25-29` does not.

Consequence in a **standalone PWA** (the delivery target per D17): the bottom nav sits under the iPhone home indicator and under Android gesture-navigation bars.

### 2.5 An inline style defeats the responsive KPI grid

`my-day/_client.tsx:924` — `style={{ gridTemplateColumns: "repeat(4, 1fr)" }}`. Inline styles beat any stylesheet rule, so `globals.css:986` (3-col under 1100px) and `:991` (2-col under 640px) never apply. On a 768px tablet, four KPI cards holding 26px mono values are squeezed into ~161px each.

### 2.6 Timezone-dependent rendering without a timezone

- `workspace/_client.tsx:25` — `toLocaleDateString("en-IN", …)` with **no `timeZone`**. Server renders in UTC, phone renders in IST. Any timestamp between 00:00–05:30 IST disagrees by one day between SSR and hydration. `my-day/_client.tsx:33-35` already guards this correctly with `timeZone: "Asia/Kolkata"` — `workspace` was missed.
- `app-shell.tsx:167-173` — `fmtWhen` branches on `Date.now()` and formats with no timezone; a notification flips between a clock time, "Yesterday" and a date.
- `dashboard/page.tsx:135, 142-143` — `new Date()` in a server component, formatted with the *server's* zone, not the device's.

### 2.7 Meaning that only exists in a hover tooltip

On a touch device these are unreadable, and in each case the tooltip is the *only* carrier of the information:

| Component | Line | What is lost |
|---|---|---|
| `stage-spine.tsx` | 56-58 | `title=` holds stage number, name, status, overdue, rejection. **The signature element of the design system renders as an unlabelled colour swatch on a phone.** |
| `matrix-heatmap.tsx` | 128-129, 139 | `title` / `aria-label` holds "SR03 · Shell Welding — Overdue 3d"; the cell shows only an icon or "48%" |
| `job-gantt.tsx` | 131 | Row name is ellipsis-truncated *and* its tooltip is hover-only |
| `dashboard/page.tsx` | 315 | Throughput bar counts |

`s-curve.tsx:93, 118` is worse: `onPointerEnter`/`onPointerLeave` with no tap handling, so on touch the tooltip appears and **sticks** until the user taps elsewhere. Its hit rects are ~25 CSS px wide on a phone.

### 2.8 Charts

- **`dashboard/page.tsx:456`** — `preserveAspectRatio="none"` on `viewBox="0 0 640 230"`. At 360px the chart is squashed to 44% horizontally while staying 100% vertically: text is distorted, the end marker becomes an ellipse, and the same polyline has different apparent thickness depending on slope. Effective label width ≈ 4.4px.
- **`s-curve.tsx:33, 88-90`** — `WIDTH = 480` with `xMidYMid meet` letterboxes to 280×128 inside a 220px-tall reserved box: ~46px of dead band top and bottom, and `fontSize={10}` renders at ~5.8 effective px.
- **`globals.css:958-959` + `job-gantt.tsx:80-86`** — `.g-months` is offset `margin-left: 190px` with no min-width while `.g-track` has `min-width: 420px`. Once the gantt overflows (below ~642px, i.e. **including 768px tablets after the 76px rail**), the two percentage bases diverge and **the month labels stop lining up with the bars.**
- Below the 10px readability floor: `.g-actual b` 9px (`:966`) — that is the overdue `+Nd` badge, the most urgent datum in the gantt — `.g-todaylab` 9px (`:969`), rail labels 9–9.5px (`:812, 820, 843`).
- `th` is 10.5px (`:632`) and is **not** raised by the coarse-pointer block, so on touch headers stay 10.5px while body cells jump to 15px.

### 2.9 Fixed widths that force horizontal scroll

| Element | Line | Min width | Effect at 360px |
|---|---|---|---|
| `.g-name` + `.g-track` | `globals.css:962` | 642px | Gantt scrolls on phone **and on 768px tablets** |
| `.uxs .cell` × 25 | `globals.css:947` | ~507px | Unit×stage strip always scrolls |
| Dept×status matrix | `dashboard/page.tsx:259` | ≥630px, ~720px on coarse | Worse on exactly the devices with least width |
| `.statstrip` 5×140px | `globals.css:865` | 700px | ~2 of 5 stats visible |
| `.gbar-row` | `globals.css:902` | 292px fixed | Bar column collapses to ~18px — cycle-time bars invisible |
| `.hp-row` | `globals.css:895` | — | Activity column ~30px → renders as an ellipsis only |

**None of the six horizontal scrollers has a touch affordance.** `globals.css:451-456` styles `::-webkit-scrollbar`, which does nothing on iOS/Android where scrollbars are transient overlays. No mask-image, no edge fade, no scroll-snap, no arrows anywhere in the stylesheet. Users will not discover the hidden content.

### 2.10 Long strings have no wrap rule

Zero `word-break` / `overflow-wrap` / `hyphens` declarations in 1048 lines of CSS. `.tag` and `.chip` are `white-space: nowrap` (`:480, :465`) and appear inside `.rt-card-row`, which wraps but cannot shrink a nowrap child below its min-content width. A long serial or job number pushes the card past the 312px content box and produces page-level horizontal scroll (`my-day/_client.tsx:271, 378, 472, 524, 611`).

`.sh-kv` is `grid-template-columns: 130px 1fr` with no phone override (`:518`), leaving ~178px for values in the full-screen phone sheet.

### 2.11 Touch targets below 48px not covered by the density layer

`globals.css:1021-1027` raises only `.btn`, `select`, `input`. Uncovered:

- `.spine > *` — 25 segments at **10.5 × 14px**, each a clickable `<button>` (`:497`)
- `.mx-cell` 26px (`:885`), `matrix-heatmap` cells `h-8` = 32px, `.g-row` 32px (`:960`), `.uxs .cell` 16px (`:947`)
- Notification bell ~25×25 (`app-shell.tsx:427`, `globals.css:441`)
- Filter-chip `×` ~13×15 (`workspace/_client.tsx:377`, `globals.css:648`)
- Sheet close button on **tablets** ~20×22 — the 48px rule is scoped `max-width: 639px` only (`globals.css:521, 546`), so at 640–1023px the sheet has no usable dismiss control
- `.tab` ~33–38px (`globals.css:941`) — the primary filter on every touch tablet
- `app-shell.tsx:365, 385, 441` — dropdown rows and the job switcher are `<div onClick>`, so no focus ring and no keyboard activation

### 2.12 Three live copies of every row on a phone

Below 640px `.day-queue` and `.day-standard` both render (`globals.css:675-680`), and inside `.day-standard` both `.rt-table` and `.rt-cards` render. Each "mine" row therefore instantiates `MineQueueCardView` + `MineRowView` + `MineCardView` (`my-day/_client.tsx:214, 260, 702`), each with its own `useState`×2 + `useTransition` + `useRouter`.

Two consequences: real CPU cost on a low-end Android, and **per-variant state is not shared** — a typed delay detail or a half-written rejection reason is lost if the device crosses a breakpoint (tablet rotation, foldable).

Related: `my-day/_client.tsx:443, 476` mount two `autoFocus` inputs simultaneously. Focusing a `display: none` element is a no-op, so tapping "Reject…" on a phone can leave focus nowhere.

### 2.13 Notification dropdown re-opens itself

`app-shell.tsx:427, 441-446` — the dropdown is nested **inside** the bell `<button>`, and `openNotification` does not `stopPropagation()`. Tapping a notification calls `setBellOpen(false)`, the click bubbles to the bell's toggle, and it re-opens. ("Mark all as read" at `:459` does call `stopPropagation` — the notification rows were missed.)

### 2.14 Non-responsive correctness bug found in passing

`dashboard/page.tsx:438` — `sCurve.filter(p => p.actual !== null).map((p, i) => ...)` uses the **filtered** index for the X coordinate. If the actual series starts late or has a gap, the actual polyline is plotted at the wrong X positions. `s-curve.tsx:54-60` guards this correctly with `actualIndices`; the dashboard copy does not.

---

## 3. The real compatibility floor: browser engine, not resolution

This is the part that cannot be fixed by CSS tweaks, so decide it deliberately.

**Tailwind v4 requires Chrome 111+ / Safari 16.4+ / Firefox 128+** (all ~March 2023). On top of that the stylesheet uses **62 `oklch()` colours and 8 `color-mix()`** with **no fallbacks**.

The failure mode is not graceful degradation. Below the floor, `oklch()` fails to parse, custom properties resolve to nothing, and the app renders as **unstyled black-on-white text** — which reads to a shop-floor user as "the app is broken", not "my phone is old."

### What this means per platform

| Platform | Reality |
|---|---|
| **Android** | Chrome updates through the Play Store, **independently of the Android version**. A 2019 phone on Android 9 still runs current Chrome. Practical risk: **low.** The exception is a device with Play Services disabled or offline for years. |
| **Android WebView** | Opening the link from inside WhatsApp uses WebView, which also auto-updates on modern Android. Low risk, but worth testing — this is how supervisors will actually first open the link. |
| **iOS** | Safari is welded to the OS version. iOS 16.4 shipped March 2023. iPhone 8 / X top out at iOS 16.7 → **fine**. iPhone 7 and older top out at iOS 15.8 → **will not render**. |

**Recommendation: do not try to support older engines.** Backfilling `oklch()` fallbacks across 62 declarations is a permanent tax on a design system built around `color-mix()`. Instead, **feature-detect and gate**:

```ts
if (!CSS.supports('color', 'oklch(0.5 0.1 250)')) {
  // render a plain-HTML "Please update Chrome / your phone" page
}
```

A one-screen unstyled-but-legible notice beats a broken dashboard. Ten lines of code, permanently closes the question.

---

## 4. On resolution fragmentation specifically

You do not need to handle "every resolution." You need **three layouts, fluid within each band** — which the architecture already does. Fragmentation is handled by:

1. **Fluid, not fixed.** Every fixed px width in §2.9 is a bug against this principle, not an unavoidable device problem.
2. **Switching on input type as well as width.** `pointer: coarse` is the reliable signal for "this is a finger." Width alone mislabels a 1024px touch tablet as a desktop (§1.3).
3. **Standardising the fleet.** ADR §2.1 already specifies Android 12+, 10", 4GB RAM, rugged case. Procurement discipline removes most of the long tail before CSS has to.

Widths that actually matter for DESPL, and whether they are currently tested:

| Width | Device | Tested? |
|---|---|---|
| **360 × 800** | The most common Android viewport in India (Redmi / Galaxy A / Realme) | **No** — matrix starts at 390 |
| 390 × 844 | Pixel 7 / iPhone 14 | Yes |
| 412 × 915 | Larger Android (Galaxy S/Note class) | No |
| **768 × 1024** | 10" tablet **portrait**, iPad portrait | **No** |
| 1024 × 768 | 10" tablet landscape | Yes — but as `hasTouch`, and it currently gets the desktop shell (§1.3) |
| 1440 × 900 | Office laptop | Yes |

**360px is the single most important missing viewport.** It is 30px narrower than the smallest currently tested, and several findings above (§2.9, §2.10) only manifest below ~390px.

---

## 5. What to do — ordered

### Round 1 — unblock the device (~1 day)

1. Add `NAV` destinations to the icon rail and a "More" sheet on the phone bottom nav (§1.1). **Nothing else matters until this is done.**
2. Add sign-out to rail + phone (§1.2).
3. Re-gate the shell on `(min-width: 1024px) and (pointer: fine)` so touch tablets keep the rail (§1.3). This also clears an existing `test.fail`.
4. Wrap `qcp-grid` in a scroll container (§1.4).

### Round 2 — device-correctness (~1 day)

5. Replace hardcoded `Inter` / `"JetBrains Mono"` with `var(--font-inter)` / `var(--font-jbmono)` — 8 rules (§2.1).
6. Raise `input.ws-detail` to 16px inside `pointer: coarse` (§2.2).
7. `100vh` → `100dvh` with a `100vh` fallback line above it (§2.3).
8. Add `viewportFit: "cover"` to the `viewport` export (§2.4).
9. Delete the inline `gridTemplateColumns` in `my-day` (§2.5).
10. Add `timeZone: "Asia/Kolkata"` to `workspace/_client.tsx:25`, `app-shell.tsx:167-173`, `dashboard/page.tsx:142` (§2.6).
11. `stopPropagation()` on notification rows (§2.13).
12. Global `overflow-wrap: anywhere` on card/sheet value slots (§2.10).

### Round 3 — touch semantics (~2 days)

13. Replace `title=` with a tap-to-open popover on `<StageSpine />` and `<MatrixHeatmap />` (§2.7). The spine is the signature component; it currently conveys nothing on a phone.
14. Raise the uncovered touch targets in §2.11 — especially the sheet close button on tablets, which has no usable dismiss.
15. Give the six horizontal scrollers an edge-fade mask + `scroll-snap` (§2.9).
16. `preserveAspectRatio="xMidYMid meet"` on the dashboard S-curve; scale chart label sizes with viewport (§2.8).
17. Fix `.g-months` / `.g-track` percentage-base divergence (§2.8).
18. Fix the filtered-index bug at `dashboard/page.tsx:438` (§2.14).

### Round 4 — prove it, don't assume it (~half a day)

19. Add **360 × 800** and **768 × 1024 portrait** to the Playwright matrix, and make the 1024 tablet project assert the *rail*, not the sidebar.
20. Add an assertion that no element's computed `font-family` resolves to a fallback when a webfont was intended — this catches §2.1 permanently.
21. Add the `CSS.supports('color', 'oklch(...)')` gate + an e2e check that the fallback page renders (§3).
22. **One real-device pass before rollout.** The cheapest possible: one ₹8–10k Android phone, one 10" tablet, one iPhone. Emulated viewports do not reproduce iOS input zoom, Android gesture-bar overlap, WebView quirks, or actual outdoor legibility.

### Round 5 — then, and only then, the PWA layer

Per ADR D17, nothing above changes the PWA decision. But shipping `manifest.json` + service worker onto a UI where a tablet cannot reach `/qc` just makes the broken version installable. **Fix §1 first.**

Still outstanding from the ADR and unrelated to this audit: **D20 (object storage vendor) blocks the photo-capture session**, and the shop-floor WiFi survey blocks the rollout checklist.

---

## 6. What was already done well (do not re-litigate)

- Three shell variants toggled by CSS, never by JS `matchMedia` — correctly avoids hydration mismatch, and the reasoning is documented in `responsive-table.tsx:3-15`.
- `pointer: coarse` density layer, deliberately placed last in the cascade with the reason written down (`globals.css:1013-1020`).
- `<ResponsiveTable />` as a structural primitive rather than a column-config grid.
- Queue-first `/my-day` below 640px.
- Outdoor mode + WCAG contrast assertions in e2e, with genuinely-blocked failures marked `test.fixme` and explained rather than hidden.
- Zero `ResizeObserver` / `getBoundingClientRect` / `innerWidth` in `src/` — no measure-then-size flash anywhere.
- Existing failures disclosed as `test.fail` with the fix named. That discipline is why this audit was quick.
