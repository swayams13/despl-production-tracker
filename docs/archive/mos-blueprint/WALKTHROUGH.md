# WALKTHROUGH — One Item, Start to Finish

**Purpose:** you have the prompts. This shows you what actually happens when you use them, using one real item, in order, including what to do when it goes wrong. Read this once before your first session.

**Short answer to "do I just start with the prompts?"** Almost. Two things come before any prompt, and both are yours:

1. **Open Railway. Which branch does production deploy from?** (Item A1.) Ten minutes.
2. **Decide the fork:** management demo soon, or proving the MOS thesis? (Item 0.8.)

Also send SJ the Phase L question pack this week — it runs on his calendar, not yours.

Then, yes: everything else is prompts.

---

## The item we'll walk: `B1 + B2`

Fixing three false claims in the repo's own documentation. It's the ideal first item because it's a **real** trip through the whole loop — branch, change, review, commit, log — with **zero** risk of breaking code. If the agent misbehaves here, you lose nothing and you learn the pattern.

*(Your very first session should actually be `A4` — the read-only baseline check. Same loop, even lower stakes. Then come back and do this.)*

---

## Step 1 — Terminal

```bash
cd ~/"AI DEVELOPMENT DESPL/DESPL/DESPL TRACKER"
git status                    # confirm clean tree
git checkout -b chore/B1-docs-drift-corrections
claude
```

Then, inside Claude: `/model sonnet` (documentation work; Opus isn't needed).

## Step 2 — One paste, not two

Copy **§2 the RULES BLOCK** from `PROMPTS.md`, then immediately below it paste the **B1 + B2 prompt** from §6. Send both as a single message.

Don't do the rules block on its own and wait — that burns a turn and the agent has nothing to anchor the reading against.

## Step 3 — Read the first response carefully

You should see, in roughly this order:

1. **The three invariants quoted verbatim** from `CLAUDE.md` (#1, #4, #9) and the first line of `errors.ts`. This is your proof it actually opened the files.
2. It reading `_shared.ts`, `workspace/page.tsx`, `portal/page.tsx`, `client-snapshot.service.ts`.
3. **Three proposed diffs**, shown to you, not applied.

### What good looks like

> "Verified (1): `assertKitReady` at `_shared.ts:684` is called from `startComponentOperation`. It returns early when `component.bomItemId == null`, and again when the BOM item has no stock lots — so the no-op case is real. Invariant #2's current text is wrong. Proposed replacement: …"

Specific line numbers. Quoted code. A claim it *checked*, not a claim it *believes*.

### Red flags — stop and push back

| What you see | What it means | What to say |
|---|---|---|
| It skips the invariant quotes and dives in | It didn't read `CLAUDE.md` | "Quote invariants #1, #4, #9 verbatim first." |
| "I've verified the client portal exists" with no file evidence | It's asserting, not checking | "Paste the actual lines you read from `portal/page.tsx`." |
| It edits the files without showing diffs | It ignored "show me first" | `Esc`. "I said show me the diffs before applying. Revert and show me." |
| It starts fixing `workspace/page.tsx`'s literal | Scope creep — that's B3 | "Out of scope. B3 handles that. Only the three doc corrections." |
| It rewrites surrounding text "for clarity" | Scope creep | "Change only what's false. Leave the tone and length alone." |

Scope creep is the failure you'll see most. It always looks helpful.

## Step 4 — Review the diffs yourself

You don't need to be an engineer for this one — you're checking three things:

- Does the new invariant #2 text describe what the agent showed you in the code?
- Does it still read like the other eleven invariants (same length, same voice)?
- Did anything change that shouldn't have? `git diff` will tell you.

If it's right: **"Apply all three."**

## Step 5 — Verify nothing broke

```
Run pnpm lint && pnpm typecheck && pnpm test and paste the literal output.
```

Documentation changes shouldn't touch tests, so you're confirming a no-op. If anything fails, something was edited that shouldn't have been.

## Step 6 — Commit

```bash
git add -A
git commit -m "[B1][B2] Correct three false claims in project documentation

- CLAUDE.md invariant #2: material gating IS implemented at component-operation
  grain via assertKitReady, with a silent no-op for never-stocked BOM items
- PHASE-PROMPTS.md §0: the workspace/page.tsx DESPL-320 literal is still open (B3)
- CLAUDE.md deferred list: the client portal was built 19 Aug, not deferred"
```

The item IDs in the subject line are what make this greppable in six months.

## Step 7 — Log and clear

Paste the **§15 end-of-session prompt**. It drafts the `progress.md` entry; you paste it in and save.

Then `/clear`. Next item starts with a clean context.

---

## What the whole first week looks like

| Day | Item | Type | Risk |
|---|---|---|---|
| Mon | A1, A2 (Railway, branch decision) | You, no AI | — |
| Mon | Phase L prompt → send question pack to SJ | AI writes, you send | None |
| Tue | A4 baseline | AI, read-only | None |
| Tue | B1 + B2 | AI, docs only | None |
| Wed–Thu | B10 literal guard | AI, real code | Low |
| Thu–Fri | B3 workspace fallback | AI, real code | Low |
| Fri | B4 admin family selector | AI, real code | Low |

By Friday you've closed five items, and — more importantly — you'll know whether this workflow suits how you work, having risked almost nothing to find out.

---

## Three things that will happen, and what to do

**The agent asks you a question mid-item.** Good — several prompts explicitly ask it to propose before building (B3's landing-page options, B5's department-resolution approaches). Answer it. That question is the prompt working as designed.

**The agent says it can't verify something.** Also good. `"I cannot log in without browser automation, so I have not verified the rendered page — reporting verification as incomplete"` is the credential rule working. Accept it and verify by hand rather than pushing it to find a way.

**The agent disagrees with the instruction.** Listen. It reads the code more closely than the plan does. If it says *"B7 says derive stages from TemplateProcess, but `workOrderStages[]` already does this and B9 covers it — these overlap"*, it may well be right. Bring it back here and we'll adjust the plan. The plan is a hypothesis about a codebase, not scripture.

---

## The one habit that matters most

**Never mark an item done without seeing its acceptance criterion demonstrated.**

Not "the agent says it works." Not "the tests pass." The specific thing the build plan said would be true — shown to you, with output or a screen you looked at.

That single habit is the difference between a plan that reports 60% complete and delivers 60%, and one that reports 60% and delivers 30%.
