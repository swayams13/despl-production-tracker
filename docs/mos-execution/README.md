# mos-execution — start here

The working set for turning this codebase into DESPL MOS. Three files, one job each.

| File | What it's for | When you open it |
|---|---|---|
| **`PROMPTS-v4.md`** | The rules block and one paste-ready prompt per session | Every session. This is the daily tool. |
| **`LEDGER.md`** | What's done, what it was demonstrated on | End of every session |
| `../DESPL_MOS_TRANSFORMATION_PLAN.md` | The five gates and why they're in this order | Once, and when a gate exits |
| `../DESPL_CODEBASE_ALIGNMENT_AND_DEVELOPMENT_ROADMAP.md` | The evidence — every claim with file:line | When you want to know *why* an item exists |

## The shape

```
GATE 0  Deployable & safe        S1–S5    ← not passed
GATE 1  DESPL-320 ships on it    S6–S15
GATE 2  A UI-created job works   S16–S21  ← the actual MOS line
GATE 3  Any family, as data      v3 §7
GATE 4  The company operates     v3 §9–11
```

## Start

```bash
git status                       # clean tree first
git checkout -b fix/W3-gating-splice-excluded-processes
claude
/model opus
```

Then paste **PROMPTS-v4.md §1 (rules block)** followed immediately by **§2 S1** as one message.

## Before you write any code — four things only you can do

1. Open Railway. Which branch does production deploy from? Write the answer down.
2. **Enable PITR today.** The retention window takes ~4 weeks to fill; it gates the ship date independently of everything else.
3. Rotate the four shared department accounts (`scripts/create-department-accounts.ts:21` — `despl123@`, `mustChangePassword:false`). Once a QC sign-off feeds an MDR, shared `fabrication@`/`qc@` credentials are a records-integrity defect, not just a security one.
4. Send two questions: the ASME/TPI record-integrity question (blocks S12), and C1 — working days or calendar days? (invalidates every date in the system until answered).

## Relationship to the older docs

`docs/mos-blueprint/` (24 documents, 31 Aug – 1 Sep) is the architecture description and target. It is **accurate on architecture and wrong on sequence**, because it predates two P0 findings. Where it and `PROMPTS-v4.md` disagree on order, v4 wins. `PROMPTS-v4.md` §5 lists the three specific corrections to v3's later phases.

`CLAUDE.md`'s twelve invariants remain the contract. Nothing here overrides them.
