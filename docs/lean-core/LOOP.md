# Development loop — how build sessions run without waiting on a person

**Added 14 Oct 2026. Owner: Swayam.** Swayam's standing instruction (14 Oct): development should keep going between his check-ins, starting with loop engineering. This file is the contract every loop iteration follows. `CLAUDE.md` binds; `PHASE-PLAN-v1.md` sets order; `BUILD-PROMPT-lean-core-v1.md` specifies each session; `LOOP-QUEUE.md` is the ordered work list; this file says how one iteration runs.

Precedence inside a loop run: `CLAUDE.md` invariants and hard bans → the "Never" list below → this file → the queue.

---

## 1. What changes from the normal session template

The normal template is *plan → wait for Swayam's go → build*. In a loop run:

- **The plan goes into the PR description instead of waiting for a go.** Swayam reviews plans and code together when he merges. This is his standing go for every queue item that is *ready* (§3), and only for those.
- **One iteration = one queue item = one branch = one PR**, then the process exits. A fresh process starts the next iteration with an empty context and re-reads the repo. Nothing carries over except git, GitHub and `progress.md`.
- **Defaults stand in for open decisions.** If a decision in `CLAUDE.md` is open, build the switch with the default from the decisions table and say so in the PR. Never record a decision on anyone's behalf.

Everything else in `CLAUDE.md` still applies: invariants, test rules (violations first, table-driven), real `/login` for browser checks, ≤ 15 lines in `progress.md`.

## 2. One iteration

1. **Discover (≤ 10 min).** `git fetch --prune`. Read `CLAUDE.md`, the last hand-off in `progress.md` on the train tip (§4), `LOOP-QUEUE.md`. List open PRs (`gh api repos/swayams13/despl-production-tracker/pulls?state=open`) and the CI result of the train tip and of `main`.
2. **Choose.** First match wins:
   1. `.loop/STOP` exists → exit at once.
   2. CI red on `main` or on any open loop PR → fix that (repair beats new work).
   3. An open review finding on a loop PR (PR comment or automated review) → fix it on the topmost branch.
   4. The first queue item whose status is **ready** (§3).
   5. Nothing ready → write the hand-off "loop idle: waiting on …" and create `.loop/STOP`.
3. **Plan.** Re-read the session's section of the build prompt, the §8 errata that map to it, and the code it touches. Write the plan (files, migration yes/no, tests, choices taken from defaults) as the first draft of the PR description. For anything Opus-class (schema, rules, gating, RBAC, audit) think it through before touching code.
4. **Execute** on branch `lean/<ID>-<slug>` cut from the train tip (§4). Small commits. Business rules in `src/lib/services/`; Server Actions thin; every refusal a stable code.
5. **Verify** (all must pass; run long commands in the background with output to a file and poll — a silent 3-minute command has stalled agents before):
   - `pnpm typecheck && pnpm lint && pnpm test && pnpm test:db` (`portfolio.read.test.ts` may need `--testTimeout=30000` until `despl_test` is rebuilt).
   - Rules, gating, RBAC, audit: a mutation check — break the rule, see the matching test fail, restore.
   - Migration: replay every migration on a throwaway DB, `prisma migrate diff` clean, RLS coverage test extended.
   - Screens: `pnpm build`; a Playwright spec through the real `/login` per role; screenshots at 1440 px and 390 px checked; no console errors. Never mint a session (CLAUDE.md "Agent conduct").
6. **Review.** Spawn one independent reviewer agent that has not seen the work: give it the diff and the build-prompt section and ask for an adversarial review (authz bypass, maker–checker, tenant isolation, audit in the same transaction, refusal codes, dead controls, errata). Fix every real finding, test first.
7. **Ship.** Push the branch; open the PR against the train tip (§4) with plan, what was verified, choices made from defaults, and "Needs Swayam". Migration PR: also push the train tip to `staging` (fast-forward only) and read the pre-deploy log and `/api/health` if the session can reach Railway; otherwise list it under "Needs Swayam".
8. **Record.** ≤ 15 lines in `progress.md` on the branch, ending with the next queue item and the "Needs Swayam" list. If the Obsidian vault path in `CLAUDE.md` exists on this machine, sync `CURRENT_STATUS.md`, `TASKS.md`, `CHANGELOG.md`.
9. **Exit.** Print one summary line: `LOOP RESULT: <ID> <PR url or "no PR"> <green|red> <next ID>`.

Time box: if an item is not green after ~2.5 hours of work, push what exists as a **draft** PR titled `WIP <ID>`, write what is failing, and exit. The next iteration treats it as a repair item.

## 3. When a queue item is ready

An item is **ready** when all of these hold:
- No branch `lean/<ID>-*` exists yet (otherwise it is built or in progress — continue it only as a repair item).
- Every item in its `after` column is merged or has an open PR in the train.
- Nothing in its `blocked by` column is open. A decision with a default is **not** a blocker (build the switch); only missing **inputs** (data or files the code literally needs) and **human-only steps** block.

## 4. The train (how branches stack)

Loop PRs form one straight line, like the L1.2 stack (#82 → #88): each new branch is cut from the tip of the newest open loop/lean PR, and its PR's base is that branch. Merge order = PR number order. Exceptions: a repair to `main` itself (CI, a production bug) branches from `main`.
- **Train cap: 12 open PRs.** At the cap, start nothing new; do repair items, reviews and test hardening on the tip branch, and put "merge the train" at the top of "Needs Swayam".
- When Swayam merges the bottom PR, he retargets the next PR to `main` (`gh pr edit <n> --base main`); the agent may not (classifier).
- Before cutting a branch: `git log --oneline origin/main..<tip>` must be a straight line. If someone else's branch sits on top of the train, stack on it and say so.

## 5. Never (stop and hand to Swayam instead)

- Merge or retarget any PR; push to `main`; change branch protection, Railway settings, secrets or environment variables.
- Touch the **production** database or service in any way (read or write), or run anything against a production dump except a local replay Swayam started.
- Flip `LEAN_FLOOR` or any `FEATURES` flag on in production, or run a `--apply` script against a shared database (staging included) unless the queue item says so.
- Record a decision (D-numbers, review decisions) or mark seed data "approved"/"signed off" (e.g. `seed/assembly-step-roles-pv-v1.json`, `seed/standard-parts-aliases.json`).
- Enter a password into a deployed host, read secrets to mint a session, or print a secret into a log, PR or `progress.md`.
- Work around a permission or classifier denial. Note it under "Needs Swayam" and move on.
- Delete code, migrations, RLS policies, tests, remote branches, or the `.claude/worktrees` directories.
- Edit an applied migration.

## 6. Running the loop

On Swayam's Mac (where Postgres, `despl_test`, the Railway CLI and the hotspot are), from the repo root:

```bash
scripts/loop/run.sh                 # until the queue is empty or .loop/STOP appears
scripts/loop/run.sh --max 3         # three iterations
touch .loop/STOP                    # stop after the current iteration
```

The runner starts a fresh `claude -p` per iteration with `scripts/loop/PROMPT.md`, `--permission-mode auto --permission-prompts none` (unattended, classifier still on; anything that would ask is denied, not waited on), a wall-clock cap per iteration (default 3 h), logs in `.loop/logs/`, a macOS notification after each iteration, and stops after 3 failed iterations in a row. It keeps the Mac awake with `caffeinate` while it runs.

Cloud sessions (claude.ai) cannot run this loop today: their network blocks `binaries.prisma.sh`, so Prisma cannot generate a client or run a migration there. They can still plan, review PRs and edit docs.

## 7. What Swayam does, and how often

- **Daily (≈ 15 min):** read the newest hand-off in `progress.md` on the train tip; answer its "Needs Swayam"; merge the bottom of the train in order (rehearse migration PRs per `MERGE-RUNBOOK.md` §5 first); retarget the next PR.
- **When asked:** decisions (D-table), sign-offs, production-dump rehearsals on the hotspot, Railway clicks, staging sign-in checks.
- **To steer:** reorder `LOOP-QUEUE.md` on `main` (or on the train tip) — the next iteration picks it up.
