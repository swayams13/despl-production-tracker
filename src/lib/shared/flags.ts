/**
 * Lean Core v1 freeze list (docs/lean-core/BUILD-PROMPT-lean-core-v1.md §4).
 *
 * When a flag is off: its nav entries are removed, its routes call
 * `notFound()`, and its Server Actions refuse with `FEATURE_FROZEN`. The
 * freeze lives at the Server Action / route layer only — services, migrations,
 * RLS policies and tests stay untouched. Flip a flag only on a recorded
 * decision in CLAUDE.md.
 */
export const FEATURES = {
  clientPortal: false,       // /portal, ProgressSnapshot publish/verify UI
  multiFamilyIntake: false,  // only PRESSURE_VESSEL selectable in /jobs/new
  cpmReplanUi: false,        // feasibility / replan / duration-override screens
  analytics: false,          // the five unbuilt analytics screens stay unbuilt
  agents: false,             // planner agent / MOS layer
} as const;
