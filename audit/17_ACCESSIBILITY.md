# 17 — ACCESSIBILITY AUDIT

*Audited against WCAG 2.2 AA at code level. Contrast ratios are computed, not
estimated — the arithmetic is shown and is independently checkable.*

**Context:** the accessibility work that was done here was done properly. The
gaps are gaps in *coverage* of that work, not in its quality. Two of the findings
below are already recorded by the team's own test suite as known failures.

---

## 1. AUD-064 (P1) — the primary interaction cannot be reached by keyboard

**WCAG 2.2 · 2.1.1 Keyboard (Level A) — fails.**

Ten occurrences on My Day alone of:

```tsx
<tr className="row" onClick={clickable ? onOpenStage : undefined}
    style={clickable ? { cursor: "pointer" } : undefined}>
<div className="rt-card" onClick={clickable ? onOpenStage : undefined} …>
```

No `role`, no `tabIndex`, no `onKeyDown`. Repository-wide there are exactly
**two** `onKeyDown` handlers against **307** `onClick` usages. Collapsible section
headers have the same defect (`<div className="hd" style={{cursor:"pointer"}} onClick={…}>`).

The one place that got it right is still incomplete:

```tsx
// job-gantt.tsx:213
<div className="g-row" onClick={onOpen} role="button" tabIndex={0}
     onKeyDown={(e) => e.key === "Enter" && onOpen()}>
```

`role="button"` must also activate on **Space** (WCAG 4.1.2 / the ARIA button
pattern).

**Impact.** A keyboard-only or switch-access user cannot open a StageSheet — and
the StageSheet is where Start / Submit / Verify live. **They cannot do the job at
all.** This is also the finding most likely to appear in a client or
government-contract conformance review.

**Fix — preferred.** Make the row's *primary cell* contain a real
`<button className="linkish">` that opens the sheet, and drop the row-level
handler. This fixes keyboard, focus order and screen-reader announcement in one
move, and removes the need for all twelve `onClick={stop}` bubbling guards — which
themselves show the pattern was understood as click-only from the start.

**Minimum acceptable.** `role="button" tabIndex={0}` plus a shared
`onActivateKey` helper handling **both** `Enter` and `" "` (with `preventDefault`
on Space to suppress page scroll). `globals.css:497` already defines
`:focus-visible { outline: 2px solid var(--accent) }`, which computes to
**7.50:1 against `--bg`** and passes 1.4.11 comfortably — **the ring is already
correct once the element is focusable.**

---

## 2. AUD-066 (P1) — two design tokens fail the 3:1 non-text minimum

**WCAG 2.2 · 1.4.11 Non-text Contrast (AA) — fails.**

| Foreground | Background | Ratio | Needs |
|---|---|---|---|
| `--border` #262A30 | `--bg` #0B0C0E | **1.36** | 3.0 |
| `--border` | `--surface` #141619 | **1.26** | 3.0 |
| `--border` | `--surface-2` #1C1F24 | **1.15** | 3.0 |
| `--s-idle` #4A4F57 | `--bg` | **2.37** | 3.0 |
| `--s-idle` | `--surface` | **2.20** | 3.0 |
| `--s-idle` | `--surface-2` | **2.00** | 3.0 |

`--border` is the boundary of every `.btn`, every text input, every `.card`,
`.tag` and table separator — and 1.4.11 requires 3:1 for the visual boundary of a
control where that boundary is what identifies it. `--s-idle` is the fill of
`idle` spine segments and the `.chip i` dot.

**The `--s-idle` figure is independently confirmed by the team's own
measurement.** `supervisor-viewport.spec.ts` carries
`test.fixme("AA contrast: dark theme's spine idle fill (--s-idle on --surface) is
2.20:1 …")` — **2.20 exactly**, matching this audit's independent computation.
`--border` is not covered by that record.

**Impact.** A supervisor on a tablet in shop-floor daylight cannot see where an
input field ends, and cannot distinguish a not-started stage from the background.
The outdoor palette exists precisely for this and sets `--border: #7c8b99`,
`--s-idle: #9aa3ac` — but it is opt-in per user, so **the default dark theme is
what most people see**.

**Fix.** `--border` → **#3A4048** (3.03:1 vs `--surface-2`, the worst case) or
**#3D444D** for margin; the visual change from #262A30 is small. `--s-idle` →
**#5C6068** (3.02:1) or **#606670** (~3.3:1) with headroom. Then delete the two
`test.fixme` markers and convert them to assertions.

---

## 3. AUD-065 (P1) — most inputs carry only a placeholder

**WCAG 2.2 · 1.3.1 (A), 3.3.2 (A), 4.1.2 (A) — fail.**

Repository census: **154 `<input>`**, **58 `<select>`**, **53 `<label>`**,
**4 `htmlFor=`** (both pairs in `login/page.tsx` and `account/password`),
**88 `aria-label=`**. The 53 labels are almost entirely checkbox wrappers, which
are correct.

The user-creation form is representative:

```tsx
<input className="ws-detail" placeholder="Name *" … />
<input className="ws-detail" placeholder="Username *" … />
<input className="ws-detail" placeholder="Email (optional)" … />
<input className="ws-detail" placeholder="Employee code (optional)" … />
<input className="ws-detail" type="password" placeholder="Leave empty to auto-generate" … />
```

Five inputs, zero accessible names. **A placeholder is not a label:** it is not
announced by every assistive technology as a name, and it **disappears on first
keystroke**, so a user who loses their place cannot recover what a field is for.

Counter-example done right in the same codebase:
`aria-label={\`Delay detail for ${row.jobNumber} · ${row.processName}\`}` — a
genuinely contextual name.

**Impact.** Admin user creation and job intake — where a mistyped employee code
or delivery date has real cost — are the least labelled screens.

**Fix.** A visible `<label htmlFor>` above each field. The density layer has
room: `.emp-hint` already renders helper text under an input, so the vertical
rhythm supports it. Where the visual design genuinely cannot carry a visible
label, `aria-label`. Then add `eslint-plugin-jsx-a11y`'s
`label-has-associated-control` to `eslint.config.mjs` so it cannot regress —
`pnpm lint` already gates CI. Land it as `warn` first, since it will fail on
existing code.

---

## 4. AUD-067 (P1) — shop-floor touch targets

**WCAG 2.2 · 2.5.8 Target Size Minimum (AA, new in 2.2) requires 24×24 CSS px.
The stated context — gloves, tablets, daylight — argues for 2.5.5's 44×44.**

```css
.spine > *      { flex: 1; height: 14px; … cursor: pointer; }   /* :502 */
.mx-cell        { height: 26px; min-width: 44px; cursor: pointer; }  /* :906 */
.uxs .cell      { width: 16px; height: 16px; cursor: pointer; }      /* :976 */
.chip           { font-size: 10.5px; padding: 2px 8px; }  /* ≈18px tall  :465 */
```

The full spine is **25 interactive `<button>` elements at `flex: 1`**: on a 390px
phone that is roughly **13px wide × 14px tall each**. Unit-matrix cells are
**16×16**. Both open the StageSheet — they are the app's signature interaction.

**What is genuinely handled:** `@media (pointer: coarse)` raises `.btn`, `select`
and `input` to `min-height: 48px`, and `.rail-item` (60×60) / `.bn-item` (64px)
were sized for touch.

**The gap** is that the density layer's selector list does not include
`.spine > *`, `.mx-cell`, `.uxs .cell`, `.chip`, or plain `<a>` links — a gap the
team **already discovered and disclosed** in the viewport spec (*"plain `<a>` text
links (e.g. my-day's 'Department view →', 22px), the notification bell (25×25)
and my-day's KPI filter `.tab` buttons (40.5px) are all genuinely under 48px on
this touch project today"*), plus a live `test.fail` recording a **1px** gap
between adjacent 48px targets in consecutive rows on tablet.

**Impact.** A 13×14px target with gloves is a mis-tap that opens the wrong stage —
and the StageSheet is where Start/Submit/Verify live, so **a mis-tap is a wrong
production record**.

**Fix.** Under `@media (pointer: coarse)`, add
`.theme-industrial .spine > * { min-height: 44px; }` with the coloured fill drawn
as an inset pseudo-element, so the **visual** bar stays 14px while the **hit
area** is 44px. This preserves the design exactly and is the standard technique.
Same for `.uxs .cell` (16px visual, 44px hit area via `::before { inset: -14px }`)
and `.mx-cell` (26 → 44px). Raise `.chip` to 44px where interactive. Then close
the two disclosed gaps (bell, `.tab` buttons) and **resolve the `test.fail`** — a
`test.fail` marker is a live defect, and this one is tracked but open.

Note this interacts with the design spec's 36px row-height rule and needs a
design decision.

---

## 5. AUD-054 (P2) — sub-12px type

| Size | CSS rules | Inline `fontSize` |
|---|---|---|
| 9px | 5 | 3 |
| 9.5px | 2 | — |
| 10px | 9 | 4 |
| 10.5px | 11 | 3 |
| 11px | 26 | 57 |
| 11.5px | 7 | 2 |
| **Total < 12px** | **60** | **69** |

Notable: `.chip` at 10.5px uppercase with 0.4px letter-spacing — **the status
label itself**; `.kpi h6` 10.5px uppercase 1px tracking; **`.rail-item span`
9.5px — the tablet navigation label**, on a 76px rail, on the shop-floor device;
the notification badge at 9px; `.stat h6` 10px uppercase 0.8px tracking; the
Units × stage matrix headers and QC yield week labels at 9px inline.

Uppercase plus wide letter-spacing at 10px reduces legibility further than the
size alone suggests.

WCAG 2.2 has no absolute minimum size, so this is **not a conformance failure** —
but 1.4.4 Resize Text and 1.4.12 Text Spacing both bite harder at these sizes,
and the stated context (daylight, gloves, presbyopic supervisors on a tablet at
arm's length) makes 9–10.5px uppercase status labels a practical readability
failure. `--muted` at these sizes still computes to 5.20–6.16:1, so **contrast is
not the compounding factor; size alone is.**

**Fix.** The `@media (pointer: coarse)` layer is the right lever and already
exists — it raises base font to 15px and `td` to 15px. Extend it to floor every
sub-12px token: `.chip` to 12px (currently bumped only to 11.5px),
`.kpi h6, .stat h6, .rail-item span, .bn-item span, .dept-tag` to 12px. On fine
pointers raise the 9px/9.5px cases to 11px minimum. **Replace the 69 inline
`fontSize:` literals with utility classes** so the density layer can reach them
at all — inline styles currently bypass every media query.

And buy the space back by **cutting columns**, per the classification tables in
`04`–`08`. Never solve density with a smaller font.

---

## 6. AUD-097 (P2) — landmarks, skip link, table semantics, disclosure state

- **No `<main>` anywhere inside `(app)`.** `grep "<main"` returns only
  `portal/page.tsx`, `login/page.tsx` and `account/password`. The app shell
  renders page content in a plain `<div className="content">`.
- **No skip link anywhere** (`grep "Skip to"` → 0 hits). The sidebar has ~20 nav
  links before content, so keyboard users tab through all of them on every page.
  **WCAG 2.4.1 Bypass Blocks (A).**
- **Duplicate landmark names** — `<nav className="icon-rail" aria-label="Primary">`
  and `<nav className="bottom-nav" aria-label="Primary">`.
- **No `scope=` attribute anywhere** (0 hits) despite real `<table>`/`<th>` markup
  throughout. Real tables with real headers is the right foundation;
  `scope="col"` is the missing one-attribute completion. **WCAG 1.3.1 (A).**
- **No `aria-sort`** on sortable columns.
- **Disclosure controls without `aria-expanded`** — the notification bell toggles
  a panel with no `aria-expanded`/`aria-haspopup`/`aria-controls`; same for three
  My Day section headers. **Two components got this right:**
  `my-day/_project-filter.tsx` and `bom-panel.tsx`.

**Fix.** (a) `<div className="content">` → `<main id="content" className="content">`;
(b) add a visually-hidden-until-focus skip link as the first child of `.app`;
(c) rename the two navs `"Primary"` / `"Primary (mobile)"`; (d) `scope="col"` on
every `<th>` — mechanical, ~60 sites; (e) `aria-sort` on the three sortable
columns; (f) `aria-expanded` + `aria-controls` on the bell and the three My Day
headers — **and make them `<button>` rather than `<div onClick>` while you are
there**, which also resolves AUD-064 for those three.

---

## 7. AUD-098 (P2) — the spine's ARIA roles cancel each other out

```tsx
<div className="spine" role="list" aria-label="Work-order stages">
  {segments.map((seg, i) => (
    <button key={i} type="button" role="listitem"
      aria-label={`Stage ${seg.stageNo}, ${seg.stageName}, ${STAGE_STATUS[seg.status].label}`}
      onClick={…} />
  ))}
</div>
```

**An explicit `role` overrides the implicit one.** `role="listitem"` removes
`role="button"`: a screen reader announces *"Stage 9, Material inspection,
overdue — list item"*, with no indication it is actionable, and it is skipped by
"list all buttons" navigation.

The `aria-label` itself is well constructed and carries status as **text** — good,
and part of why §9 passes.

**Impact.** The signature navigation element is announced as static content.
Combined with AUD-067's 13px hit area, **the spine is the least accessible
control in the app despite having had the most accessibility thought put into
it.**

**Fix.** Drop `role="list"` and `role="listitem"` entirely and keep the native
`<button>` semantics plus `aria-label` — a row of buttons in a labelled
`<div role="group" aria-label="Work-order stages">` conveys the structure
adequately. If list semantics are genuinely wanted, wrap each button in an `<li>`
inside a `<ul role="list">`. The `mini` variant's `aria-hidden="true"` is correct
and should stay.

---

## 8. Full contrast table

WCAG 2.x formula: linearise sRGB per channel (`c/12.92` below 0.03928, else
`((c+0.055)/1.055)^2.4`), luminance `0.2126R + 0.7152G + 0.0722B`, ratio
`(L_light + 0.05)/(L_dark + 0.05)`. Chip fills are the status colour composited
at 12% alpha over the named background.

### Solid text on the three surfaces — dark palette

| Foreground | Background | Ratio | AA 4.5 | AA 3.0 |
|---|---|---|---|---|
| `--text` #E7E9EC | `--bg` | 16.09 | PASS | PASS |
| `--text` | `--surface` | 14.90 | PASS | PASS |
| `--text` | `--surface-2` | 13.59 | PASS | PASS |
| `--muted` #8B919A | `--bg` / `--surface` / `--surface-2` | 6.16 / 5.71 / 5.20 | PASS | PASS |
| `--accent` #FF7A1A | `--bg` / `--surface` / `--surface-2` | 7.50 / 6.95 / 6.33 | PASS | PASS |
| `--s-complete` #3FB950 | ” | 7.70 / 7.14 / 6.50 | PASS | PASS |
| `--s-progress` #4C8DFF | ” | 6.11 / 5.66 / 5.16 | PASS | PASS |
| `--s-submitted` #A371F7 | ” | 5.84 / 5.41 / 4.93 | PASS | PASS |
| `--s-hold` #D9A62E | ” | 8.80 / 8.15 / 7.43 | PASS | PASS |
| `--s-overdue` #F0524D | ” | 5.61 / 5.20 / 4.74 | PASS | PASS |
| **`--s-idle` #4A4F57** | ” | **2.37 / 2.20 / 2.00** | **FAIL** | **FAIL** |
| **`--border` #262A30** | ” | **1.36 / 1.26 / 1.15** | n/a | **FAIL (1.4.11)** |

### AUD-102 (P2) — status chip label on its own 12% tint

| Chip text | Composited background | Ratio | AA 4.5 |
|---|---|---|---|
| `--s-complete` over `--surface` / `--bg` / `--surface-2` | rgb(25,42,32) / (17,33,22) / (32,49,41) | 5.93 / 6.60 / 5.39 | PASS |
| `--s-progress` over `--surface` / `--bg` | rgb(27,36,53) / (19,27,43) | 4.86 / 5.38 | PASS |
| **`--s-progress` over `--surface-2`** | rgb(34,44,62) | **4.38** | **FAIL** |
| `--s-submitted` over `--surface` / `--bg` | rgb(37,33,52) / (29,24,42) | 4.65 / 5.15 | PASS |
| **`--s-submitted` over `--surface-2`** | rgb(44,41,61) | **4.20** | **FAIL** |
| `--s-hold` over all three | | 6.68 / 7.44 / 6.00 | PASS |
| `--s-overdue` over `--surface` / `--bg` | rgb(46,29,31) / (38,20,22) | 4.59 / 5.04 | PASS |
| **`--s-overdue` over `--surface-2`** | rgb(53,37,41) | **4.16** | **FAIL** |
| `.c-idle` text #9AA0A8 on 25% `--s-idle` | over `--surface` / `--bg` | 5.89 / 6.41 | PASS |

**All three failures are on `--surface-2`, the nested-panel background.** Because
the chip is 10.5px — well under the large-text threshold — the 4.5 column is
binding, so `.c-progress`, `.c-submitted` and `.c-overdue` fail AA wherever a
chip sits on a nested panel. **Fix:** darken the tint on `--surface-2`
(`color-mix` toward `--bg`) — a 6% tint instead of 12% restores all three above
4.5 — or nudge the three hues lighter.

### Status fills as UI components (1.4.11 → 3.0)

| Fill vs `--bg` | Ratio | Passes 3.0? |
|---|---|---|
| `--s-complete` | 7.70 | PASS |
| `--s-hold` | 8.80 | PASS |
| `--s-progress` | 6.11 | PASS |
| `--s-submitted` | 5.84 | PASS |
| `--s-overdue` | 5.61 | PASS |
| **`--s-idle`** | **2.37** | **FAIL** |

### Controls and focus

| Pair | Ratio | Verdict |
|---|---|---|
| `.btn-accent` text `#000` on `--accent` | **8.05** | PASS — correct choice; **white would have been 2.61, a fail** |
| Focus ring `--accent` vs the three surfaces | 7.50 / 6.95 / 6.33 | PASS (1.4.11) |
| 12% chip fill vs its own ground | 1.13–1.22 | Not a failure — status is conveyed by the label text, not the fill |

---

## 9. What passes, and deserves saying

**Status-by-colour-alone: PASSES.** `StatusChip` always renders a text label
alongside the dot, and adds a per-status SVG glyph on coarse pointers — **three
redundant channels**. Spine segments carry `aria-label` and `title` naming the
status in words. Overdue and rejected secondary markers are distinct **shapes**
in opposite corners (round pip vs square), not just colours. This part of the
design spec is honoured in the implementation.

**Reduced motion: PASSES.** `globals.css:1061-1065` disables `pageFadeUp`,
`sheetIn`, `fadeIn`, `pop` and the spine transition under
`prefers-reduced-motion: reduce`; `:1007-1009` disables the skeleton shimmer.

**AUD-103 (P2) — one gap:** the `CountUp` component animates in **JavaScript**,
which no CSS media query can stop. It needs a
`window.matchMedia("(prefers-reduced-motion: reduce)")` check that snaps straight
to the final value. Two CSS transitions also escape the block —
`.pbar i { transition: width .8s }` and `.bars .b i { transition: height .7s }`.

**The StageSheet's keyboard behaviour is genuinely solid.** It uses Radix
`Dialog`, which supplies focus trap, focus restore, Escape-to-close, `aria-modal`
and `role="dialog"` for free.

**`login/page.tsx` and `account/password` use `role="alert"` for form errors.**
Sonner's `<Toaster>` provides its own polite live region.

**Three palettes including a purpose-built outdoor high-contrast one**, stored
**per user in the database** rather than localStorage — genuinely good shop-floor
engineering.

**`e2e/wcag-contrast.ts` is a correct, hand-verified implementation of the WCAG
formula.** This audit computed `--s-idle` independently and got 2.20:1 against
`--surface` — exactly matching the team's own recorded figure. The measurement
infrastructure is right; it is being used to *document* two failures rather than
to gate them, which is the one thing to change.

---

## 10. Priority

| # | Finding | Effort | Why |
|---|---|---|---|
| 1 | **AUD-064** keyboard operability | M | The only Level A failure that blocks a user from doing the job |
| 2 | **AUD-066** two token values | **S** | Two hex values; already measured by the team's own helper |
| 3 | **AUD-097** `<main>`, skip link, `scope=` | M | Three Level A failures, all mechanical |
| 4 | **AUD-065** input labels | M | Land the ESLint rule as `warn` first |
| 5 | **AUD-067** touch targets | M | Needs a design decision on row height |
| 6 | **AUD-098** spine roles | **S** | Delete two attributes |
| 7 | **AUD-102** chip tint on `--surface-2` | **S** | One `color-mix` |
| 8 | **AUD-103** `CountUp` reduced motion | **S** | One `matchMedia` check |
| 9 | **AUD-054** sub-12px type | M | Extend the coarse-pointer layer; needs the column cuts first |
| 10 | Convert the two `test.fixme` and one `test.fail` into assertions | **S** | Do this last, as the acceptance gate for 2, 5 and 7 |
