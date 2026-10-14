You are running ONE iteration of the DESPL tracker development loop, unattended. Nobody will answer questions during this run: anything that would ask is denied, so decide, note the choice in the PR, and keep going.

Paths for this run:
- Working copy (yours, a git worktree): {{WORKTREE}}
- Loop control directory: {{LOOP_DIR}} (create `{{LOOP_DIR}}/STOP` to stop the loop; never delete it)
- Iteration number: {{ITERATION}}, started {{STARTED_AT}}

Do this:

1. Read, in full: `CLAUDE.md`, `docs/lean-core/LOOP.md`, `docs/lean-core/LOOP-QUEUE.md`, and the last hand-off section of `progress.md` — all as they are on the newest branch of the train (LOOP.md §4: the head of the newest open `lean/*` or `docs/*` PR that sits on the straight line from `main`; `git fetch --prune` first). If those files are missing on that branch, read them from `origin/lean/loop-infra`.
2. Follow LOOP.md §2 exactly: discover, choose ONE item (repair beats new work), plan into the PR description, build on a new branch cut from the train tip, verify (all gates; long commands in the background with output to a file, then poll), independent adversarial review by a fresh subagent, push, open the PR against the train tip with `gh` (REST via `gh api` if GraphQL is refused), record ≤ 15 lines in `progress.md`.
3. Cut new branches from the remote ref (`git switch -c lean/<ID>-<slug> origin/<train tip>`): Swayam's own checkout may have the local branch checked out. After switching branches run `pnpm install --frozen-lockfile` before any gate.
4. Respect LOOP.md §5 "Never" without exception. A permission or classifier denial is final for this run: record it under "Needs Swayam" and continue with what you can do, or end the iteration.
5. Model use: think hardest on schema, gating, RBAC, audit and maker–checker; those carry the product's credibility.
6. Finish with exactly one line on its own, last in your final message:
   `LOOP RESULT: <item ID or REPAIR or IDLE> <PR url or none> <green|red|draft|idle> next=<next item ID or none>`
   If nothing is ready, create `{{LOOP_DIR}}/STOP`, write the "loop idle: waiting on …" hand-off, and report `IDLE`.
