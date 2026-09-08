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
