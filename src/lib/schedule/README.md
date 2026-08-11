# lib/schedule

The scheduling engine. Implements the two-layer model from BUILD-SPEC-v2 §1:

- **Envelope layer** (authoritative) — `finishByMinDays`/`finishByMaxDays` reproduce the printed
  17-week figure exactly. Drives tender quoting and the feasibility check.
- **CPM DAG layer** (fitted lags) — drives live replanning, critical path/float, and gating.
  Negative lags are legitimate `START_TO_START_WITH_OVERLAP` concurrency, not data errors.

Forward, backward, feasibility and override modes all live here. Gating and scheduling are
separate concerns: a lag can let a process start early, but never lets it complete out of
predecessor order, and never overrides a hold point (CLAUDE.md invariants #2 and #11).
