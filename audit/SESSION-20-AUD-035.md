# SESSION 20 — AUD-035 · A duration override destructively overwrites the printed envelope

*Implementation prompt. Self-contained — assumes no prior conversation context.*
*Source: `audit/10_BUSINESS_LOGIC.md` §4, `audit/20_REMEDIATION_ROADMAP.md` Phase 1c item 21.*
*"M" complexity, and genuinely a judgment call — the current code already
contains a deliberate, reasoned partial mitigation for part of this problem.
Read "What the current code already does, and why" in full before concluding
the fix is a simple deletion.*

---

## PASTE FROM HERE

You are a Staff Backend Engineer working on **DESPL Production Tracker**
(Next.js 15 + Prisma 6 + PostgreSQL 16). This session addresses a scheduling
invariant violation: applying a duration override overwrites the job's
printed, supposedly-immutable envelope dates in place, and a shortening
override can permanently break the ability to reschedule the job at all.

### Read before writing anything

1. `CLAUDE.md` — invariant #10 ("the printed envelope is authoritative and
   never derived") and invariant #6 ("corrections create versions, never
   destructive edits").
2. `audit/10_BUSINESS_LOGIC.md` §4, the "AUD-035" subsection, in full.
3. `src/lib/services/override.service.ts` — `applyDurationOverride` in full.
   **Read the existing comment block above the restamp loop carefully** — it
   is long, deliberate, and already grapples with part of this exact
   problem. Do not skim it.
4. `src/lib/schedule/feasibility.ts` — `checkFeasibility` in full, especially
   the bare `throw new Error(...)` at the `requiredMinDays > requiredMaxDays`
   guard (not an `AppError`).
5. `src/lib/services/schedule.service.ts` lines ~55-120 (`generateSchedule`)
   — see exactly how `terminal.envelopeFinishByMaxDays` /
   `terminal.envelopeFinishByMinDays` are read off `JobProcess` (Layer 1) and
   fed into both `subtractWorkingDays` (BACKWARD mode's project-start anchor)
   and `checkFeasibility`. Note the comment: *"Feasibility is a tender-stage
   check: only meaningful when we know both the order window's ends"* — this
   is a clue about what feasibility is actually supposed to be checked
   against; read "The actual question this session must answer" below.
6. `prisma/schema.prisma` — `model JobProcess`'s four envelope columns
   (`envelopeStartByMinDays`, `envelopeFinishByMinDays`,
   `envelopeStartByMaxDays`, `envelopeFinishByMaxDays`) and `model ProcessPlan`'s
   `plannedStart`/`plannedFinish`/`baselineStart`/`baselineFinish`.
7. `grep -rn "envelopeFinishByMaxDays\|envelopeFinishByMinDays\|envelopeStartByMaxDays\|envelopeStartByMinDays" src/lib src/app --include=*.ts`
   — find **every** reader of these four columns, not just the two you've
   already seen, before deciding what's safe to stop writing.

### What the current code already does, and why

```ts
// override.service.ts — the existing restamp loop, with its own comment
// (paraphrased structure; read the real file for the full text)
//
// "Fix the Layer-1↔Layer-2 desync (flagged medium bug)... restamp [MAX
// offsets] from the recomputed CPM so computeEnvelope (Layer 1) and the CPM
// plan (Layer 2) agree on MAX... MIN offsets are intentionally left
// untouched (audit C2). A min-space CPM pass here would use the SAME lags
// the schedule was fitted against for MAX durations only — in min space
// those lags corrupt the terminal node... so every job with one override
// reads requiredMinDays ≈ 36 forever after and checkFeasibility can never
// again return INFEASIBLE."

for (const p of spine.rawProcesses) {
  const mx = maxByPid.get(p.id);
  if (!mx) continue;
  await tx.jobProcess.update({
    where: { id: p.id },
    data: { envelopeStartByMaxDays: mx.earlyStart, envelopeFinishByMaxDays: mx.earlyFinish, ... },
  });
}
```

**This is not an oversight — it is a targeted, already-reasoned mitigation**
for a real, specific downstream failure (a corrupted MIN-space CPM pass
producing a nonsensically small `requiredMinDays` that would make
`checkFeasibility` structurally unable to ever report INFEASIBLE again). The
author chose to overwrite MAX only, leaving MIN untouched, as "the lesser
wrong." Whoever picked this up clearly understood invariant #10 was at
stake and made a deliberate trade.

**The audit's finding stands regardless**: overwriting `JobProcess`'s printed
MAX envelope columns in place is still a destructive edit to Layer 1,
recoverable only by parsing the audit-log JSON blob — and it is still
possible (a large enough shortening override) for the now-mismatched MAX
(restamped, smaller) and MIN (untouched, original) to invert, at which point
`checkFeasibility`'s `requiredMinDays > requiredMaxDays` guard throws a bare
`Error`, not an `AppError`, on the **next** `generateSchedule` call for this
job — an unexplained 500 with no application-level recovery path, since
nothing can un-corrupt the now-permanently-wrong MAX envelope short of a
manual DB edit.

### The actual question this session must answer

Does anything genuinely **need** `JobProcess.envelopeFinishByMaxDays` /
`envelopeStartByMaxDays` to reflect the override-adjusted CPM position, or
was the restamp only ever added to keep `checkFeasibility`'s **next**
`generateSchedule` call from using a stale MAX bound?

Trace this for real, using your step-7 grep results, before choosing a
design:

- If `checkFeasibility` (and everything else reading these columns) is
  **only ever consulted at intake / whole-schedule-regeneration time** — a
  "was this job feasible against its original committed order window"
  question — then feasibility is fundamentally a question about the
  **printed, original envelope**, and restamping it after a mid-project
  override was never the right fix in the first place: an override
  shortening one process's duration doesn't retroactively change what was
  promised at intake. In this case, the correct fix is to **stop restamping
  entirely** — leave all four envelope columns exactly as printed at intake,
  forever, and let `checkFeasibility` keep checking against that original
  commitment on every future `generateSchedule` call, override or not.
- If something **does** need the current, override-adjusted CPM position
  read back later (check your grep results for any reader outside
  `schedule.service.ts`'s own `generateSchedule`), that need should be
  served from **Layer 2** — the current `ScheduleRun`'s `ProcessPlan` rows,
  which already carry `plannedStart`/`plannedFinish` reflecting exactly this
  information — not from `JobProcess`'s Layer-1 columns. Confirm whether
  `plannedStart`/`plannedFinish` already carries everything that reader
  needs before adding any new column.

**Do not assume without checking** — this is exactly the kind of design call
this codebase's own comment shows a previous engineer got partially right
and partially compromised on. Verify your conclusion against the actual set
of readers you found, and state your reasoning explicitly in your PR.

### Your task

**1 — Resolve the design question above**, based on real evidence from your
own grep, not this prompt's framing alone.

**2 — Stop the destructive Layer-1 write.** Whichever direction step 1
lands on, `override.service.ts`'s transaction should no longer call
`tx.jobProcess.update` with `envelopeStartByMaxDays`/`envelopeFinishByMaxDays`
in its data payload for any process other than genuinely legitimate,
non-derived fields (`durationOverrideDays`, `overrideReason` on the
target process itself remain correct to write — those ARE the override's own
input, not a derived envelope value). Remove the restamp loop's write to
`JobProcess`, while preserving whatever of its logic (the CPM recompute
itself, feeding `plans`) is still needed to build the new `ScheduleRun`'s
`ProcessPlan` rows correctly — that part of the function is legitimate
Layer-2 work and should be untouched.

**3 — Fix `checkFeasibility`'s bare `Error`.** Change the
`requiredMinDays > requiredMaxDays` guard to throw a real `AppError`:

```ts
if (requiredMinDays > requiredMaxDays) {
  throw new AppError(ERROR_CODES.SCHEDULE_DATA_MISSING, {
    requiredMinDays, requiredMaxDays,
  }, "Envelope data is inconsistent: minimum duration exceeds maximum.");
}
```

Check whether `SCHEDULE_DATA_MISSING` is semantically the right existing
code to reuse here (it's currently used for a different case — a null
envelope) or whether a new, more specific code (e.g.
`SCHEDULE_ENVELOPE_INVALID`) is more honest — check `errors.ts`'s existing
naming conventions and pick accordingly, adding the new code plus its
`ERROR_MESSAGES` entry and HTTP mapping (409) if you add one.

**4 — If step 1 concluded the restamp should stop entirely**, confirm this
doesn't silently break the one thing the original comment was protecting
against — re-run the exact failure scenario the comment describes (a
shortening override, then a subsequent `generateSchedule` call) against your
fix and confirm `checkFeasibility` now throws your new `AppError` (a
graceful, explainable refusal) rather than either the old bare `Error` or a
silently-wrong feasibility verdict.

### Details that matter

- **`durationOverrideDays`/`overrideReason` are legitimate writes and stay**
  — they are the override's own recorded input on the target `JobProcess`
  row, not a derived Layer-1 envelope value. Only the four envelope columns
  are in scope here.
- **The audit log's `restamped` payload becomes moot if you remove the
  restamp** — if so, simplify `recordAudit`'s `after` block accordingly
  rather than recording an empty/misleading `restamped: []` array forever.
  If you decide instead that a different form of "what changed" needs
  recording, design it explicitly rather than leaving dead fields.
- **Do not touch `computeEnvelope`, `selectTerminal`, or the CPM engine
  itself** — this session is scoped to what `override.service.ts` writes and
  how `checkFeasibility` fails, not the scheduling math.
- **`applyDurationOverride` has no UI caller today** (confirmed by the audit:
  "Currently latent... but it is exported and reachable") — this makes the
  fix safe to land without a live-traffic migration concern, but do not
  treat that as license to under-test it; it's reachable by the API/action
  layer and will be wired to a screen eventually.

### Constraints — these are binding

- **Invariant #10 is the hard constraint**: whatever you land on, the four
  `JobProcess` envelope columns must never be overwritten by anything other
  than the original intake/`generateSchedule`-at-creation-time write path,
  after this session ships.
- **No schema change** unless step 1's investigation genuinely finds a
  reader that needs new state Layer 2 doesn't already carry — if so, justify
  the new field explicitly in your PR rather than defaulting to one.
- **Every check stays transactional** — you're changing what gets written
  inside the existing transaction, not its boundaries.

### Tests

Add to `override.service.test.ts` and `feasibility.test.ts` (check both
exist; DB-gated where relevant):

| # | Scenario | Expect |
|---|---|---|
| 1 | Apply a duration override, then read the target and downstream `JobProcess` rows' four envelope columns | **unchanged** from before the override — this is the core regression guard for invariant #10 |
| 2 | Apply a large shortening override, then call `generateSchedule` again for the same job | either succeeds (if step 1 concluded feasibility should check the original envelope, unaffected by the override) or throws your new `AppError` cleanly (never the old bare `Error`, never a 500) |
| 3 | `checkFeasibility` called directly with `requiredMinDays > requiredMaxDays` | throws the new `AppError` with a stable code, not a bare `Error` |
| 4 | The new `ScheduleRun`'s `ProcessPlan` rows after an override | still correctly reflect the override's CPM recompute (`plannedStart`/`plannedFinish`) — confirms Layer 2 still gets the right data even though Layer 1 no longer does |
| 5 | Whatever reader(s) you found in step 7 of "Read before writing anything" that consume the envelope columns | still function correctly reading the now-never-restamped Layer-1 values — confirm none of them was silently relying on the old (buggy) restamp behavior |

### Verify before you finish

```bash
pnpm lint && pnpm typecheck
pnpm test:db
```

### When you are done

1. Open a PR. **Do not merge to `main` directly.** State explicitly which
   direction you took on "The actual question this session must answer,"
   quote the specific readers your grep found, and explain why removing the
   restamp doesn't reproduce the exact failure mode the original comment was
   protecting against.
2. Append an entry to `docs/mos-execution/LEDGER.md`.
3. In `audit/19_MASTER_ISSUE_REGISTER.md`, mark **AUD-035** closed with the
   PR reference.

### Explicitly out of scope for this session

| Finding | What you may notice |
|---|---|
| AUD-030, AUD-034 | Other schedule/view findings in nearby files — different bugs, already handled in other sessions |
| The CPM engine's own correctness | Untouched — this session is about what gets written where, not the math itself |

## PASTE TO HERE
