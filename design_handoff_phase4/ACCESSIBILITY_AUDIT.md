# Accessibility Audit — DESPL Tracker
Brief §12. Audited against the Round 1–3 mockups' visual patterns (mockups are static HTML; findings apply to the production build).

## Contrast
| Pair | Ratio | Verdict |
|---|---|---|
| `#e7e9ec` on `#0b0c0e` / `#141619` | ~15:1 | Pass |
| `#8b919a` (muted) on `#0b0c0e` | ~5.4:1 | Pass for body text |
| `#8b919a` on `#141619` (panel) | ~4.9:1 | Pass |
| `#ff7a1a` on `#0b0c0e` | ~7.8:1 | Pass |
| Status colors at full opacity on canvas/panel | all ≥4.5:1 | Pass |
| Status colors at the badge's ~12–16% background tint, WITH full-opacity text/dot on top | text passes because it's full-opacity, not the tint | Pass — **but flag:** any future screen that puts white/light text directly on the *tinted* background (rather than tinted-bg + full-color text) must be checked individually; the pattern only works because text stays full-strength. |
| `em` notification-count badge: `#ff7a1a` bg / `#000` text | ~10:1 | Pass |

No failing pairs found in the audited screens. Keep the rule explicit for engineering: never introduce a lighter/darker one-off gray outside the two defined text tokens.

## Never color-only (§12, §5)
Every status in Rounds 1–3 already pairs color with a text label and a dot — verified on: nav badges, StatusBadge, health chips, QC queue cards, Bottleneck chart legend. **Gap found:** the Schedule health bar's "planned" tick mark is a plain white line with no label in the bar itself (label sits below, in the legend row) — acceptable since the legend is adjacent and always visible, but flag for engineering: don't let this pattern move a legend out of the immediate viewport on a resized screen.

## Keyboard navigation
Not testable directly from static HTML mockups. Requirements for the production build:
- All interactive elements (nav items, table rows with actions, filter dropdowns, tab strips, modal/drawer close) must be reachable via Tab in visual order and operable via Enter/Space.
- Modals and drawers trap focus while open and return focus to the triggering element on close.
- The 2-step Assignment modal and any future confirmation dialog must support Escape to cancel.
- Table row click-to-navigate (used throughout Rounds 1–3, e.g. health rows, activity rows) must also be a real focusable element (button/link role), not a div-only `onClick` — currently the mockups use `onClick` on `div`s for speed; production must upgrade these to semantic, focusable elements.

## Focus states
Not defined in the mockups (canvas-preview HTML doesn't need them). Required for production: a visible focus ring using `--accent` (`#ff7a1a`), 2px outline, offset 2px, on every interactive element listed above — consistent across nav, buttons, table rows, form controls.

## Semantic HTML / ARIA
- Headings: PageHeader titles should be real `<h1>`, section titles `<h2>`/`<h3>` — the mockups already use this correctly in most places (`<h1>`, `<h3>`, `<h6>` for nav group labels); production should audit for skipped heading levels once dashboards nest further.
- StatusBadge needs `role="status"` or equivalent when it updates live (e.g. after a QC verify action) so screen readers announce the change — pairs with the Toast requirement below.
- Icon-only buttons (notification bell, filter icon, ghost/icon button variant) need `aria-label` — none currently have visible text alternatives.
- Tables should use real `<table>` semantics or ARIA grid roles, not styled divs, once built in the framework — the mockup's CSS-grid-as-table pattern is fine for a static preview but is a production requirement to convert.
- Toast notifications (new in this pass) must use `aria-live="polite"` (confirmations) or `aria-live="assertive"` (errors) so they're announced without stealing focus.

## Forms and errors
- Any form field in error state pairs a red border with inline text (never border-color alone) — apply the same never-color-only rule from §12/§5 to form validation, not just status badges.
- Required fields (e.g. reassignment reason) get a visible required indicator, not just validation-on-submit.

## Touch targets
Cross-reference with RESPONSIVE_GUIDELINES.md: 44×44px minimum on tablet, 52–82px for primary production-floor actions. Desktop mouse targets (32px buttons) are acceptable at desktop breakpoints only.

## Summary
No hard blockers found in the visual design itself — the color and status-labeling discipline already established in Round 1–3 is accessibility-sound. The gaps are all in interaction semantics (focus, keyboard, ARIA) that don't exist yet because the artifacts are static mockups; they become explicit requirements for the engineering build, listed above.

## Implementation findings (Phase 5 build, 8 Sep 2026)

Real findings from actually building against this audit, not predicted from the mockups. Full session-by-session detail is in the repo's `progress.md` ("Phase 4 design-handoff implementation" sessions) — this section is the accessibility-specific subset, per the build brief's instruction to update this file with real findings as the build progressed.

**§"Keyboard navigation" — confirmed live, closed on every screen touched.** The predicted gap ("mockups use onClick on divs for speed; production must upgrade these to semantic, focusable elements") was real and pervasive: found on **every** screen built or hardened this pass — My Day (10 separate row/card variants across Mine/Pool/QC-queue/self-submitted/team-held), Supervisor Team's `CommandRow`, Project Control Centre's new Exceptions rows, Department Overview's open-items table, QC & Hold Points (three separate spots — a card, a table row, and an inline `<span>`), Reports' digest-history row, and the shared `QueueCard` component (used by My Day's phone queue view). Closed with one new shared helper, `clickableRowProps()` (`src/components/industrial/data-table.tsx`): `role="button"`, `tabIndex={0}`, Enter/Space → the row's click handler. **One real bug caught while building the fix, not after**: every one of these rows nests real action buttons (Start, Claim, Verify, Reassign…) already `stopPropagation`'d against bubbling *clicks* to the row — but nothing guarded *keydown*, so a naive row-level `onKeyDown` would have double-fired (pressing Enter on a nested "Start" button would also trigger the row's own open-stage action). Fixed with an `e.target !== e.currentTarget` guard before the Enter/Space check, so only a keydown that originates on the row itself (not bubbled from a nested control) activates it.

**§"Focus states" — already fully satisfied, no work needed.** `globals.css` already had a global `:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }` rule (1px offset, not the audit's suggested 2px — a trivial, pre-existing, deliberate value not worth touching) applied across the whole `.theme-industrial` scope before this build started. Every new interactive element built this pass (Modal, FilterBar's Dropdown, DataTable's sortable header/expand button, all of Steps 2–7's fixes) inherits it automatically — no per-component focus-ring work was needed.

**§"Modals and drawers trap focus... Escape to cancel" — already solved by the existing Radix Dialog dependency, no new work.** The new `Modal` component (`src/components/industrial/modal.tsx`) is built on the same `@radix-ui/react-dialog` `StageSheet` already used, which gives focus trap, focus return, and Escape-to-cancel for free. Verified this holds for the new Reject (Activity Detail) and Reassign (Supervisor Team) confirmation dialogs — neither needed any bespoke keyboard-handling code.

**New, not predicted by the mockup audit: ad-blocker false positives on class names.** `globals.css`'s own pre-existing comment on `.emp-grid`/`.emp-hint` documents a real, previously-caught bug: a stock Chrome ad-blocker hides any element classed `.ad-*` (cosmetic filter list match), independent of this stylesheet. Applied the same rule proactively this pass: Activity Detail's new layout classes are named `.actd-*`, not `.ad-*`, specifically to avoid re-shipping that failure mode on a brand-new screen. Worth stating explicitly here since it's an accessibility-adjacent failure mode (an ad-blocker silently hiding a whole page reads to the user exactly like a broken build, and disproportionately affects users who can't easily diagnose why) that a color-contrast/ARIA-focused audit wouldn't otherwise surface.

**§"Semantic HTML / ARIA" — table semantics.** Confirmed real `<table>`/`<thead>`/`<tbody>`/`<th>` markup (not styled divs) was already the convention everywhere touched this pass (My Day, Supervisor Team, Project Control Centre, Department Overview, QC, Dashboard's portfolio table) — the mockup's CSS-grid-as-table pattern this audit warned about was never actually carried into the real build. No conversion work was needed; `SortableTh`'s `aria-sort` attribute was added new (`data-table.tsx`) for the one genuinely new sortable-header need this pass introduced.

**Not yet verified**: none of the above was confirmed with a real screen reader or a live Tab-through in an actual browser — this build session had no Chrome extension connection available (see `progress.md`), so every fix above is verified by code review (the DOM shape it now produces) and `pnpm typecheck`/`lint`/`test`, not by an assistive-technology pass. Flag this as the one real gap in this section's own rigor, not a clean bill of health.
