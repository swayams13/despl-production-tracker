// One-time production op — replaces the single all-access ba@despl.local
// login with 4 department-scoped SUPERVISOR/QC accounts, per the user's
// request (26 Aug 2026): fabrication, qc, procurement, and a second
// production/floor login also scoped to FABRICATION (no separate
// "PRODUCTION" department exists in the schema — see seed/lead-time-model.json).
// The initial credential is a TEMP credential read from the environment, and
// every account is created with mustChangePassword=true so the holder must
// replace it at first login. It is never committed.
//
// History (D3, 3 Sep 2026): this file previously hardcoded a shared literal
// password with mustChangePassword=false. That is a records-integrity defect,
// not merely a security one — `fabrication@` and `qc@` are different userIds,
// so `assertMakerChecker` sees two distinct people, and one human holding both
// shared logins could submit an inspection under one and verify it under the
// other. That is the invariant an MDR's credibility rests on (CLAUDE.md #3).
// Anyone with repo read access held both. The literal is gone; rotating the
// four ALREADY-CREATED production accounts is a separate step — use Admin →
// Employees → "Reset password", which calls `resetUserPassword` (bumps
// sessionVersion, re-arms mustChangePassword, audits without logging the
// credential).
//
// Follows scripts/bootstrap-admin.ts's pattern exactly: real createUser
// service call under a synthetic actor, connecting via DIRECT_URL as table
// owner. Not a session/JWT forge — no cookie or token is created.
//
// Usage:
//   DEPT_ACCOUNT_TEMP_PASSWORD=... DIRECT_URL=... DATABASE_URL=... pnpm db:create-dept-accounts
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { createUser } from "../src/lib/services/admin.service";
import { ROLES, type Actor } from "../src/lib/authz";

const PASSWORD = process.env.DEPT_ACCOUNT_TEMP_PASSWORD ?? "";
if (!PASSWORD) {
  // Fail closed. A default here is how the previous literal survived: a
  // fallback that "just works" is a fallback nobody replaces.
  throw new Error(
    "create-department-accounts: DEPT_ACCOUNT_TEMP_PASSWORD is not set. " +
      "Set it to a temp credential for this run — accounts are created with " +
      "mustChangePassword=true, so each holder replaces it at first login.",
  );
}

const ACCOUNTS: { email: string; name: string; roleCode: (typeof ROLES)[keyof typeof ROLES]; deptCode: string }[] = [
  { email: "fabrication@despl.local", name: "Fabrication", roleCode: ROLES.SUPERVISOR, deptCode: "FABRICATION" },
  { email: "qc@despl.local", name: "QC", roleCode: ROLES.QC, deptCode: "QC" },
  { email: "production@despl.local", name: "Production", roleCode: ROLES.SUPERVISOR, deptCode: "FABRICATION" },
  { email: "procurement@despl.local", name: "Procurement", roleCode: ROLES.SUPERVISOR, deptCode: "PROCUREMENT" },
];

async function main() {
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL ?? process.env.DATABASE_URL });
  const org = await owner.organization.findFirst({ select: { id: true } });
  if (!org) throw new Error("create-department-accounts: no organization found");
  const tenantId = org.id;

  const departments = await owner.department.findMany({ where: { tenantId }, select: { id: true, code: true } });
  const deptIdByCode = new Map(departments.map((d) => [d.code, d.id]));
  await owner.$disconnect();

  const bootstrapActor: Actor = {
    userId: 0,
    tenantId,
    clientId: null,
    name: "bootstrap",
    email: "bootstrap@local",
    roles: [ROLES.ADMIN],
    departmentIds: [],
    mustChangePassword: false,
    themePreference: "SYSTEM",
    outdoorMode: false,
  };

  for (const acc of ACCOUNTS) {
    const departmentId = deptIdByCode.get(acc.deptCode);
    if (!departmentId) throw new Error(`create-department-accounts: unknown department code "${acc.deptCode}"`);
    const user = await createUser(bootstrapActor, {
      name: acc.name,
      email: acc.email,
      roleCodes: [acc.roleCode],
      departmentIds: [departmentId],
      password: PASSWORD,
      mustChangePassword: true,
    });
    console.log(`Created ${acc.roleCode} user ${user.email} (id ${user.id}) scoped to ${acc.deptCode}.`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
