# lib/schedule

The scheduling engine. Implements the two-layer model from BUILD-SPEC-v2 §1. Every module here is
a pure function over plain data (`ScheduleProcess`/`ScheduleEdge`/`WorkCalendarInput` from
`types.ts`) — no Prisma import, no database — so it is fully unit-testable and the DB mapping
happens one layer up, in a future `lib/services/`.

| Module | Layer | What it does |
|---|---|---|
| `calendar.ts` | — | Working-day math (`isWorkingDay`, `addWorkingDays`, `subtractWorkingDays`, `workingDaysBetween`). Isolated on purpose: C1 (working vs calendar days, still open with DESPL) only touches this file. |
| `envelope.ts` | 1 (authoritative) | `computeEnvelope` — reads the printed `envelopeFinishBy*/StartBy*Days` offsets straight from the template, never sums durations (invariant #10). Refuses `SCHEDULE_DATA_MISSING` for any provisional/null-duration process rather than guessing. |
| `cpm.ts` | 2 (fitted lags) | `computeCpm` (forward+backward pass, float, critical path), `scheduleForward` (PO date → dispatch date), `scheduleBackward` (required delivery date → per-process finish-by dates, drives notifications). Verified to reproduce Layer 1's `finishByMaxDays` exactly at every one of PRESSURE_VESSEL v1's 36 processes. |
| `gating.ts` | — | `assertCanStart` / `assertCanComplete`. A negative-lag edge lets a process start while its predecessor is still `IN_PROGRESS` (real concurrency) but **never** lets it reach `COMPLETE` before every predecessor does (invariants #2, #11). QCP hold points are a separate, later concern (BUILD-SPEC-v2 §11) — not implemented here. |
| `feasibility.ts` | — | `checkFeasibility` — the tender-stage FEASIBLE/TIGHT/INFEASIBLE check from BUILD-SPEC-v2 §1.5. |
| `override.ts` | — | `applyOverride` — mandatory reason, returns baseline and current as distinct objects (invariant #6: never mutate). Persisting the resulting `ScheduleRun` version + audit row is `lib/services`' job once that layer exists. |

`__fixtures__/pressure-vessel-v1.ts` parses the real `seed/lead-time-model.json` (not a hand-typed
stand-in) so the regression tests — including the DE0467 feasibility case in
`feasibility.test.ts` — exercise the actual seeded numbers.
