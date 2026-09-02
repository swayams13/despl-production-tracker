# 24 — What the Build Plan Does *Not* Cover

**Why this document exists:** `22_DESPL_MOS_BUILD_PLAN.md` was derived from the codebase and the forensic audit. That means it is an **engineering** plan built from **technical** evidence — and it inherited two blind spots from its own sources: work that isn't code, and work whose evidence lives in documents the audit didn't weight heavily. This document names both, plus one factual correction to the blueprint itself.

Read this before committing to the timeline in `22`. It changes it.

---

## 1. Correction — a capability the blueprint under-reported

**The client portal is built. My earlier documents implied it wasn't.**

Verified directly:
- `src/app/portal/page.tsx` — a real, working route (45 lines)
- `src/lib/services/client-snapshot.service.ts` + `client-snapshot.read.ts`, both with test files
- `ProgressSnapshot` model with a full publish → verify → reject workflow (`publishedBy`/`publishedAt`/`verifiedBy`/`verifiedAt`/`rejectionReason`), maker-checker-shaped
- The portal reads **exclusively VERIFIED snapshot rows** — a client can never see an unverified progress claim, which is a genuinely thoughtful design
- A design spec exists: `docs/superpowers/specs/2026-08-19-client-portal-daily-updates-design.md`

**This is documentation drift of exactly the same class as invariant #2.** `CLAUDE.md`'s "Deferred to Phase 2 — do NOT build yet" list still names *"TPI/client portal (Viewer role reserved)"* — but it was built on 19 Aug. Add this to item **B1** as a third correction.

**Consequences for the blueprint:**
- `reference/01` §1 describes CLIENT_VIEWER as "a reserved but unbuilt role" — **wrong**, correct it.
- `reference/13` should describe the client portal as a live capability.
- `execution/21` omitted it from scoring entirely. Corrected score below.
- `execution/22` has no items for it. It needs some — see Phase O.

| Field | Score | Note |
|---|---|---|
| Client portal / progress snapshots | **6 / 10** | Real, tested, verified-only reads. Gaps: no document attachments to share (needs Phase D), snapshot publishing is manual, and it's unproven with a real external client |

**What this near-miss means more generally:** this codebase has been built faster than its own documentation tracks. Assume there are other capabilities more complete than the docs claim. `progress.md` is 476KB and is the most reliable record of what actually exists — grep it before assuming something is missing.

---

## 2. The biggest gap: DESPL business decisions that block engineering

`docs/BUILD-SPEC-v2.md` §7 carries **C1–C27, open questions that "MUST be answered by DESPL."** Each currently runs on a *default assumption* the team chose in order to keep moving. My build plan never mentioned a single one of them. That's a serious omission, because several are load-bearing and a wrong default silently corrupts real numbers.

The ones that matter most:

| # | Question | Why it blocks | Default in use |
|---|---|---|---|
| **C1** | Are the lead-time table's "Days" working days or calendar days? Holiday list? | **Changes every computed date in the system.** Flagged in CLAUDE.md as the highest-impact open input | Calendar days, 6-day week, Sunday off |
| **C21** | A dispatch date given as a window (`15.10.2026 - 25.10.2026`) — is the commitment the earliest or the latest? | Feasibility verdicts. Worth 8 working days on DE0467 alone | Earliest |
| **C22** | A revised order date — does the clock restart, per equipment or per job? | Against the revised date DE0467 is 38 working days short, not 22 | Original PO date |
| **C23** | Which processes are **optional per client**? PWHT is skippable, yet nothing is flagged optional in the lead-time table | **This is a real MOS capability question** — template-level vs per-job deviation. It may need schema/UI work nobody has scoped | None flagged; all 36 included |
| **C9** | Department supervisors and representatives | **Blocks notification routing — which is my Phase E.** Building a scheduler that notifies nobody in particular is half a feature | 13 drafted departments |
| **C7** | What do RW and R&A mean, and which block production? | QCP blocking logic — i.e. whether the system refuses correctly | RW≈Witness, R&A≈blocking |
| **C27** | Which set of 25 work-order stage names is canonical? Two schemes disagree | Every stage label the UI shows. **Directly touches item B7** | Seed's `workOrderStageNames` pinned |
| C10 | Component-type classification for BOM lines — auto by keyword or manual? | Route assignment | Manual with keyword suggestion |
| C5, C6, C8, C11, C12 | Job identity, block labels, traceability model, operation vocabulary, date format | Data accuracy and modelling | Various |

**Note on C27 and B7:** my item B7 tells you to delete the hardcoded 25-name table and derive stages from the job's route. That is still the right fix — and it makes C27 *moot for every family except pressure vessels*. But the PV display labels themselves still need SJ to pick between the two competing schemes. Do B7 anyway; ask C27 in parallel.

### → New **PHASE L — Business inputs and decisions** (owner: you + SJ, not a developer)

| # | Item |
|---|---|
| L1 | Get C1 answered. It changes every date in the system; everything scheduling-related is provisional until it's settled |
| L2 | Get C21, C22, C23 answered — all three change feasibility verdicts on live jobs |
| L3 | Get C9 answered before Phase E — supervisors and representatives per department, or notifications have no routing target |
| L4 | Get C7 and C27 answered |
| L5 | Collect the outstanding master data CLAUDE.md still lists: **welder list, weld-map joint numbering, department supervisor + representative names** |
| L6 | Decide C23's mechanism: if processes are optional per client, is that a template variant, a per-job exclusion, or a new concept? This may add items to Phase C |

**Sequencing:** L1, L3, L5 are prerequisites, not parallel work. Start them **this week**, because they run on DESPL's calendar, not yours — and a two-week wait for an answer is two weeks of building on a default that might be wrong.

---

## 3. A hole inside a phase I already wrote

**Phase E schedules a daily digest that has nowhere to go.**

Verified: there is **no email, WhatsApp, SMS, or any delivery integration anywhere in the codebase** — no nodemailer, no SendGrid, no Resend, no Twilio, no SMTP config. `CLAUDE.md` describes the digest payload as "already email-ready jsonb," which is true, but the sender does not exist.

So Phase E as written delivers a scheduled digest to the database and stops. That is not an operating rhythm.

### → New items for Phase E

| # | Item |
|---|---|
| E9 | Choose and integrate a delivery channel. Email is the obvious first one; **WhatsApp is worth serious consideration** for an Indian shop floor where supervisors live in WhatsApp and may never open a web app for a morning digest |
| E10 | Per-user delivery preferences and opt-out |
| E11 | Delivery failure handling — a bounced digest must be visible, not silent |
| E12 | Decide what management actually wants delivered vs. pulled. Ask before building |

---

## 4. Work that isn't code, and isn't in the plan at all

This is the category my plan missed most completely. A MOS that works perfectly and that nobody uses has failed.

### → New **PHASE M — Adoption, migration and rollout**

| # | Item | Why |
|---|---|---|
| M1 | **Cutover plan per department.** How does FABRICATION stop using its spreadsheet and start using the system, on a live job, without losing a day? | Nobody has written this. It's the highest-risk unplanned activity in the project |
| M2 | **Data migration for in-flight jobs.** DESPL-320 is seeded. What about jobs currently running in spreadsheets when you go live? | Either they migrate, or they finish on the old system and only new jobs start on the MOS. That's a decision, and it changes the rollout shape |
| M3 | **User provisioning at scale.** `scripts/create-department-accounts.ts` exists, but what's the real flow for onboarding every supervisor, inspector and operator? | 13 departments of real people |
| M4 | **Password reset / account recovery for shop-floor users.** `mustChangePassword` exists; verify whether self-service reset does | A worker locked out at 7am on a dispatch day is an operational incident |
| M5 | **Training per role.** Supervisor, QC inspector, operator, department head — each needs a different 30 minutes | The refusals (gating, maker-checker, delay reasons) will feel like the system is broken until someone explains they're deliberate |
| M6 | **A "why did it refuse me" guide.** The 48 error codes are excellent; users need them in plain language | This is the single biggest source of early user frustration in gated systems |
| M7 | **User acceptance sign-off per department.** Engineering DoD ≠ "the QC inspector agrees this works" | My playbook's definition of done has no user-acceptance gate. It should |
| M8 | **Feedback loop** — how a supervisor reports "this screen doesn't match how we actually work" | The demo mandate in CLAUDE.md anticipates team feedback; nothing captures it systematically |

### → New **PHASE N — Production operations readiness**

| # | Item | Why |
|---|---|---|
| N1 | **Backup and restore — and an actual restore drill.** | A system of record with an append-only audit trail and no proven restore is one incident from catastrophe. Railway's managed Postgres has backups; nobody has verified a restore works |
| N2 | **Data retention / archival policy.** The schema's own comment: `AuditLog` is unpartitioned, "fine to ~20M rows, convert to PARTITION BY RANGE(at) while the data is still small" | Cheap now, expensive later. Decide the trigger point |
| N3 | **Incident runbook.** Who is called, what they check, how they roll back | Nothing exists. `/api/health` is the entire operational surface |
| N4 | **Environment strategy.** CLAUDE.md: "no separate staging environment exists yet" | Phase A5 raises it; nobody has decided it |
| N5 | **Access review process.** Roles are re-fetched per request (good) — but who periodically reviews who has what? | Ordinary governance for a system holding QC records |
| N6 | **ASME / TPI record requirements.** Does a maker-checker click legally satisfy the signature and record-integrity expectations for an MDR that a third-party inspector or client will audit? | **Nobody has asked this question.** For ASME pressure-vessel work it is a real one, and the answer could impose requirements on the audit trail, on document retention, and on e-signatures. Ask your TPI contact before Phase D's document model is finalised, not after |

---

## 5. Deferred product capabilities not in the plan

Not gaps exactly — deliberate deferrals, per CLAUDE.md. Listed so they're visible rather than forgotten.

### → **PHASE O — Backlog (not scheduled)**

| # | Item | Note |
|---|---|---|
| O1 | **i18n — Hindi / Gujarati** | CLAUDE.md: Phase 2, and it needs the *infrastructure* built first, not just translation. Every label is currently a plain TSX literal. For an Indian shop floor this may matter more than several scheduled items |
| O2 | Geo-tagged photo evidence | Deferred; a component file explicitly notes the camera/geotag section was omitted. Becomes cheap once Phase D exists |
| O3 | Offline writes | Deferred; real for a shop floor with patchy wifi |
| O4 | PWA / installable mobile | CLAUDE.md: "Not a PWA — not currently planned" |
| O5 | Client portal enhancements | Now that §1 establishes it exists — document sharing (needs Phase D), automatic snapshot publishing, TPI-specific access |
| O6 | Broader exports and reporting | Only one export route exists today (QCP → xlsx). Management will ask for more |
| O7 | Costing / commercial | Explicitly out of scope per `reference/01` §4. Listed so the boundary stays deliberate |

---

## 6. Revised picture

| | Before | After |
|---|---|---|
| Engineering weeks (solo) | 12–16 | **16–22** (adds E9–E12, M3–M4, N1–N4) |
| Non-engineering work | Not tracked | **Phase L + most of M** — runs on DESPL's calendar, largely in parallel, but L1/L3/L5 **block** engineering |
| Phases | 12 | 16 (adds L, M, N, O) |
| Biggest unplanned risk | — | **Adoption.** Every engineering item could land perfectly and the project still fails if 13 departments don't switch off their spreadsheets |

## 7. What to do about it this week

1. **Start Phase L now**, in parallel with Phase A. C1, C9 and the master-data list (L5) run on SJ's availability, not yours. Ask this week or you'll be building on defaults for another month.
2. **Ask the TPI/ASME records question (N6)** before Phase D's document model is designed. Retrofitting a compliance requirement into a storage model is expensive; designing for it is nearly free.
3. **Add the client-portal correction to item B1** — it's the third documentation-drift fix, alongside invariant #2 and the PHASE-PROMPTS claim.
4. **Assume more capabilities exist than the docs admit.** Before building anything, grep `progress.md`. The client portal was found this way and it was already built.

---

*This document exists because the honest answer to "does the plan cover everything?" was no. It now covers considerably more — but the category most likely to still be under-represented is the one that isn't visible in a codebase at all: what the people in those 13 departments actually need in order to switch.*
