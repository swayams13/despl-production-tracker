# SESSION 23 — AUD-079 · Admin password reset defeats maker–checker

*Implementation prompt. Self-contained — assumes no prior conversation context.*
*Source: `audit/12_SECURITY_RBAC.md` §5, `audit/20_REMEDIATION_ROADMAP.md` Phase 1c item 23.*
*"M" complexity — the preventive half is a genuine small two-step workflow,
not a one-line guard. Read "The design call" before writing any code.*

---

## PASTE FROM HERE

You are a Staff Backend Engineer working on **DESPL Production Tracker**
(Next.js 15 + Prisma 6 + PostgreSQL 16). This session closes a gap that
undermines the maker–checker invariant at its root: a single administrator
can reset a QC user's password, sign in as them, and manufacture a
complete, apparently-valid verification chain for work the admin performed
themselves.

### Read before writing anything

1. `CLAUDE.md` — the maker–checker invariant.
2. `audit/12_SECURITY_RBAC.md` §5 (AUD-079) in full.
3. `src/lib/authz/index.ts` — `assertMakerChecker` (~line 144) and
   `requireRole` (~line 102). Confirm `assertMakerChecker` only ever checks
   *actor identity* (`submittedBy !== actor.userId`), never anything about
   how that actor's session/credential came to exist.
4. `src/lib/services/admin.service.ts` — `resetUserPassword` in full
   (`grep -n "export async function resetUserPassword" -A 40 src/lib/services/admin.service.ts`).
   Read its own doc comment carefully — it already documents the
   compensating controls that exist (`mustChangePassword: true`,
   `sessionVersion` bump alerting the real user at next login) and the
   SPEC §9 rule that a plaintext password is "never persisted, never logged,
   never in the audit payload."
5. `src/lib/services/client-snapshot.service.ts` — `verifySnapshot`, as the
   audit's own cited precedent for "the two-actor pattern already
   implemented and working." Read it closely: its actual mechanism is
   simpler than a full approval workflow — it just refuses when the acting
   user is the same person who did the prior step
   (`if (pending.some((r) => r.publishedBy === actor.userId)) throw
   MAKER_CHECKER_VIOLATION`). This session's fix needs a **real second
   action by a second person**, not just an identity-mismatch check on a
   single call — see "The design call" below for why those are different.
6. `prisma/schema.prisma` — `model UserRole`, `model Role`, `model User`
   (`sessionVersion`, `mustChangePassword`). Confirm how a user's role codes
   are actually queried elsewhere (`grep -n "tx.role.findMany\|userRoles"
   src/lib/services/admin.service.ts`) — reuse that exact pattern.
7. `src/lib/shared/schemas.ts` — `resetPasswordSchema` (~line 378). Confirm
   it currently takes `userId` and an optional `password`, nothing else.

### The defect

```ts
// authz/index.ts:144-148 — genuinely enforced, but only against actor identity
export function assertMakerChecker(actor: Actor, submittedBy: number | null): void {
  requireRole(actor, ROLES.QC);
  if (submittedBy !== null && submittedBy === actor.userId)
    throw new AppError(ERROR_CODES.MAKER_CHECKER_VIOLATION, { submittedBy });
}

// admin.service.ts, resetUserPassword — no target-role exclusion, no second approver
export async function resetUserPassword(actor: Actor, input: ResetPasswordInput) {
  ...
  requireRole(actor, ROLES.ADMIN);
  const tempPassword = password ?? generateTempPassword();
  // resets ANY user in the tenant, including QC and other ADMIN accounts
}
```

An ADMIN who is also a "maker" on some piece of work can: submit as
themselves, reset a QC account's password, sign in as that (now
admin-controlled) QC identity — a genuinely distinct `actor.userId` — and
pass `assertMakerChecker` cleanly, because the check only ever asked "is
this a different user id," never "is this credential still actually
controlled by the person it belongs to." **A single administrator can
manufacture a complete, apparently-valid verification chain — accepted
stages, cleared hold points, a dispatch release on a vessel nobody
independently inspected — and the system has no way to distinguish this
from a legitimate second inspector's real sign-off.**

### The design call this prompt is making

The audit's suggested preventive fix ("refuse the reset when the target
holds QC or ADMIN unless a second ADMIN approves — mirroring the two-actor
pattern already implemented and working in `client-snapshot.service.ts`")
is easy to state and easy to under-build. `client-snapshot.service.ts`'s
pattern works because it's checking a fact already on record (who published)
against the current actor — it needs no new state and no second real-world
action. **A genuine second-approver control here cannot be a same-call
field** (e.g. an `approverUserId` parameter the initiating admin fills in
themselves) — that proves nothing; the same admin who wants to bypass
maker–checker can just supply a second admin's id they happen to know,
with no actual second person involved. A real control needs **two separate
actions, by two separate authenticated sessions**, the same shape this
codebase already uses for exactly this kind of decision:
`qcp.service.ts`'s `recordQcpExecution` (stamps a pending state) +
`approveQcpWaiver` (a distinct actor, distinct call, distinct session,
stamps the approval) — AUD-003's fix, already shipped in this batch.

**This session follows that precedent**, not a single-call field:

1. When the reset target holds `QC` or `ADMIN`, `resetUserPassword` no
   longer resets anything immediately. It records a pending request and
   returns no password.
2. A new action, `approvePasswordReset`, callable only by a **different**
   `ADMIN` than the one who requested it, performs the actual reset and
   returns the temp password to the approver (who is then responsible for
   handing it to the employee, exactly as today's single-step flow already
   documents).
3. Resetting a non-QC, non-ADMIN target (the overwhelming majority case —
   SUPERVISOR, PRODUCTION_HEAD, MANAGEMENT, CLIENT_VIEWER accounts) is
   **unaffected** — immediate reset, exactly as today. This session adds
   friction only where the compliance risk actually lives.

If, having read the actual admin workflows in this codebase, you conclude a
lighter-weight mechanism (e.g., a mandatory manual out-of-band confirmation
logged elsewhere, not a DB-backed pending state) is more appropriate for
this specific system's operational reality, say so explicitly in your PR
with your reasoning — but do not ship the "same-call `approverUserId`
field" version; it does not close the actual gap.

### Your task

**1 — Schema.** A minimal pending-request record — do not persist a
plaintext password on it (SPEC §9's rule applies here just as much as to
the immediate path):

```prisma
model PendingPasswordReset {
  id           Int      @id @default(autoincrement())
  tenantId     Int      @map("tenant_id")
  targetUserId Int      @map("target_user_id")
  requestedBy  Int      @map("requested_by")
  requestedAt  DateTime @default(now()) @map("requested_at")
  status       PendingPasswordResetStatus @default(PENDING)
  approvedBy   Int?     @map("approved_by")
  approvedAt   DateTime? @map("approved_at")

  tenant Organization @relation(fields: [tenantId], references: [id])
  target User @relation("PendingPasswordResetTarget", fields: [targetUserId], references: [id])
  requester User @relation("PendingPasswordResetRequester", fields: [requestedBy], references: [id])
  approver User? @relation("PendingPasswordResetApprover", fields: [approvedBy], references: [id])

  @@map("pending_password_resets")
}
enum PendingPasswordResetStatus { PENDING APPROVED REJECTED }
```

Match this codebase's actual existing naming/mapping conventions exactly
(check a comparable recent model, e.g. whatever Session 04/AUD-003 added
for the QCP waiver, for the real convention rather than trusting this
sketch verbatim). Enroll the new table in the same tenant RLS policy family
as other tenant-grain tables (`tenant_isolation`, fail-closed) — confirm the
exact policy-application pattern from an existing migration.

**2 — `resetUserPassword`'s new branch.** Before generating any password,
fetch the target's role codes (reuse the existing `tx.role.findMany`
pattern from elsewhere in this file). If any is `QC` or `ADMIN`:

```ts
const request = await tx.pendingPasswordReset.create({
  data: { tenantId: actor.tenantId, targetUserId: userId, requestedBy: actor.userId },
});
// audited(...) — action: "admin.passwordReset.requested", no plaintext involved
return { pending: true, requestId: request.id };
```

Otherwise, keep today's immediate-reset behavior byte-for-byte unchanged.
This means `resetUserPassword`'s return type needs to express both outcomes
— check every current caller of this function (`grep -rn
"resetUserPassword" src/app --include=*.ts`) and update them to handle the
new pending-response shape (likely: show "reset requested, awaiting a
second admin's approval" instead of a temp-password slip).

**3 — New `approvePasswordReset` action**, requiring `ADMIN` and a distinct
actor from the request's `requestedBy`:

```ts
export async function approvePasswordReset(actor: Actor, input: { requestId: number }) {
  requireRole(actor, ROLES.ADMIN);
  return withTenant(actor.tenantId, async (tx) => {
    const request = await tx.pendingPasswordReset.findFirst({ where: { id: input.requestId, tenantId: actor.tenantId, status: "PENDING" } });
    if (!request) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "PendingPasswordReset", requestId: input.requestId });
    if (request.requestedBy === actor.userId) {
      throw new AppError(ERROR_CODES.MAKER_CHECKER_VIOLATION, { requestedBy: request.requestedBy });
    }
    const tempPassword = generateTempPassword();
    return audited(tx, actor, async () => {
      const passwordHash = await hashPassword(tempPassword);
      await tx.user.update({ where: { id: request.targetUserId }, data: { passwordHash, sessionVersion: { increment: 1 }, mustChangePassword: true } });
      await tx.pendingPasswordReset.update({ where: { id: request.id }, data: { status: "APPROVED", approvedBy: actor.userId, approvedAt: new Date() } });
      return { result: { tempPassword }, audit: { action: "admin.passwordReset.approved", entityType: "User", entityId: request.targetUserId, eventType: "UserPasswordReset", eventPayload: { userId: request.targetUserId, requestedBy: request.requestedBy, approvedBy: actor.userId } } };
    });
  });
}
```

Reuse `MAKER_CHECKER_VIOLATION` — it's semantically exactly this ("a second
distinct actor is required and wasn't provided"); confirm this reads
correctly in whatever error-message surface renders it to the user, and
adjust the message if it's currently phrased in a way that only makes sense
for the QCP-submission context.

**4 — Detective control, regardless of the preventive flow above.** Extend
the existing audit spec so any password-reset event (both the immediate
path for non-QC/ADMIN targets, and the new pending/approved path) records
the target's role codes at the time of the action, and add an alert
(reuse whatever this codebase's existing alerting/notification mechanism is
— check `notifications.service.ts`) whenever a reset — pending or immediate
— targets a `QC` or `ADMIN` account, addressed to other ADMINs so the
control is visible even before a second approval happens.

**5 — Correct the comment in `authz/index.ts`.** The audit specifically
calls out that `assertMakerChecker`'s documentation "reads as stronger than
the system can deliver" — update its doc comment to state plainly what it
does and does not guard against (actor-identity mismatch only; credential
provenance is a separate concern, addressed by this session's reset-approval
flow), so a future reader doesn't over-trust it the way this finding shows
the system currently does.

### Details that matter

- **Compensating controls (`mustChangePassword`, `sessionVersion` bump)
  already exist and must be preserved** — both the immediate path (non-QC/
  ADMIN targets) and the new approval path must still set them.
- **Do not let a pending request block a genuinely urgent reset forever** —
  confirm there's a sensible way for the target's own account lockout to be
  resolved if no second admin is available quickly (this may just mean: the
  tenant needs at least two ADMIN accounts for this control to function at
  all — if a real tenant only has one ADMIN, flag this explicitly in your
  PR as an operational constraint the fix introduces, since a single-admin
  tenant could now be unable to reset its own QC accounts' passwords at all).
- **`generateTempPassword`/`hashPassword` stay exactly as they are** —
  reused, not reimplemented, in the new approval path.

### Constraints — these are binding

- **The plaintext password must never be generated, hashed, or returned
  until approval** — do not pre-generate it at request time "for
  convenience"; that would defeat the entire point of requiring a second
  action.
- **`approvePasswordReset` must refuse a same-actor approval** — this is the
  core of the fix; test it explicitly, don't just assume the check works.
- **No plaintext password ever enters the audit payload**, at either step —
  matches the existing SPEC §9 rule this file already documents.

### Tests

Add to `admin.service.test.ts` (check it exists; DB-gated):

| # | Scenario | Expect |
|---|---|---|
| 1 | ADMIN resets a SUPERVISOR's password | unaffected — immediate reset, temp password returned, exactly as today |
| 2 | ADMIN A resets a QC user's password | request recorded, `PENDING`, no password returned to A |
| 3 | ADMIN A attempts to approve their own request from #2 | refused, `MAKER_CHECKER_VIOLATION` |
| 4 | ADMIN B (distinct from A) approves the request from #2 | succeeds — password reset actually happens, temp password returned to B, target's `sessionVersion` bumped, `mustChangePassword` set |
| 5 | ADMIN A resets another ADMIN's password | same pending/approval flow as QC (target holds ADMIN) |
| 6 | Approving an already-`APPROVED` or nonexistent request id | refused, `NOT_FOUND` |
| 7 | Detective control: any reset targeting QC/ADMIN (pending or immediate — confirm there is no longer an "immediate" path for these targets) generates the expected alert to other ADMINs | alert recorded/sent |

### Verify before you finish

```bash
pnpm lint && pnpm typecheck
pnpm test:db
npx prisma migrate diff --exit-code
```

### When you are done

1. Open a PR. **Do not merge to `main` directly.** Note explicitly the
   single-admin-tenant operational constraint this introduces (per "Details
   that matter"), and confirm every existing caller of `resetUserPassword`
   was updated for its new dual return shape.
2. Append an entry to `docs/mos-execution/LEDGER.md`.
3. In `audit/19_MASTER_ISSUE_REGISTER.md`, mark **AUD-079** closed with the
   PR reference.

### Explicitly out of scope for this session

| Finding | What you may notice |
|---|---|
| AUD-003 | The QCP waiver two-step pattern this session's design borrows from — already shipped, not to be re-touched |
| Any other admin-service action's authorization | Out of scope — only `resetUserPassword` and its new approval counterpart |

## PASTE TO HERE
