# START HERE

**You are looking at 23 documents. You do not need to read 23 documents.**

Read this page, then `PROMPTS.md`. That is enough to start building today. Everything else is reference you open only when a specific question comes up.

---

## The folder

```
docs/mos-blueprint/
├── START-HERE.md            ← you are here
├── PROMPTS.md               ← copy-paste prompts, phase by phase. Your daily tool.
├── DESPL_MOS_BLUEPRINT.md   ← the master summary. Read once. Show this to management.
│
├── execution/               ← what you actually use while building
│   ├── 21_..._MATURITY_SCORECARD.md   — where every area stands, /10
│   ├── 22_..._BUILD_PLAN.md           — the ~90 work items, phase by phase
│   └── 23_..._EXECUTION_PLAYBOOK.md   — how the work runs (branching, done-ness, review)
│
└── reference/               ← the architecture analysis. Open on demand, not front to back.
    └── 01–20                — one document per domain
```

## What to read, and when

**Right now, to start building (about 30 minutes):**
1. This page.
2. `PROMPTS.md` §1 and §2.
3. `execution/22_..._BUILD_PLAN.md` — Phases 0, A, and B only. Skip the rest for now.

**Once, when you have an hour:** `DESPL_MOS_BLUEPRINT.md`. It is the whole system in one document.

**Never front to back:** `reference/01–20`. Those exist so that when you are building item `C4` and need to know how the workflow model is supposed to behave, you open `reference/07` and get the answer with evidence. Reading them all in sequence is how you get the confusion you have right now.

**Before starting each phase:** the relevant section of `PROMPTS.md`, plus that phase's items in `22`.

**At each phase exit:** `execution/23_..._EXECUTION_PLAYBOOK.md` §7.2, then update the scores in `21`.

## Which document answers which question

| Your question | Document |
|---|---|
| What am I building next? | `execution/22` (build plan) |
| What exact prompt do I paste? | `PROMPTS.md` |
| How do I run the work — branches, tests, done-ness? | `execution/23` (playbook) |
| How good is area X today, and how much is left? | `execution/21` (scorecard) |
| What is DESPL MOS, in one document? | `DESPL_MOS_BLUEPRINT.md` |
| How is the workflow / BOM / QC / scheduling *supposed* to work? | `reference/07`, `08`, `11`, `09` |
| Why was this decided this way? | `reference/20` (decisions + principles) |
| What is broken or missing, ranked? | `reference/17` (gap matrix) |

---

## The three-minute version of the situation

Your system is a **very good pressure-vessel production tracker (8.1/10)** and a **partially-built company-wide MOS (5.4/10)**.

The hard parts are done and verified: the cross-department dependency engine, the gating/maker-checker enforcement, the CPM scheduler, the audit trail. There are no family-specific branches anywhere in the gating, scheduling, or authorization code — the platform claim in your own ADR holds up.

What is missing is **tooling, not architecture**. Three things carry roughly half the remaining work:

1. Nobody can create a new product family, route, or QCP without a developer writing JSON.
2. There is no file storage anywhere — no certificate, drawing, or photo can be attached to anything.
3. There is no scheduler — the daily digest is a button someone presses.

And one thing needs answering before any of it matters: **`demo` is 77 commits ahead of `main`, and deploy is configured from `main`.** Two weeks of work may not be live.

---

## Do this today

1. **Answer the deploy question.** Open Railway, find which branch the production service deploys from. This is Phase A1 and it takes ten minutes. Everything else is guesswork until it's answered.
2. **Decide one thing** (Phase 0.8, in `22`): are you heading for a **management demo soon**, or for **proving the MOS thesis**? They are different two-month plans, and `PROMPTS.md` §3 tells you which order to run.
3. **Paste Prompt A** from `PROMPTS.md` into a Claude Code session and work Phase A.

That's it. Don't read the reference documents today.

---

## The one rule that matters most

Every item you build gets asked one question before it ships:

> *"If we won an identical heat exchanger tomorrow, what code changes?"*

The answer must be **none**. That question is why this system is a platform rather than a pressure-vessel app, and it is the thing that quietly erodes if nobody asks it. It's built into every prompt in `PROMPTS.md` as a stop condition.
