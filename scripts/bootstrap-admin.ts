// One-time production bootstrap — creates the first ADMIN user.
//
// pnpm db:seed:reference creates zero users by design, and createUserAction
// requires an already-authenticated ADMIN actor, so there is no way to reach
// the first admin through the UI. This runs the exact same createUser
// service call the UI uses (real password hashing, real RLS-scoped write,
// real audit row), driven by a synthetic bootstrap actor instead of a
// session — mirrors bootstrap-schedule.ts's owner-client pattern for
// resolving the tenant. Not a session/JWT forge: no cookie or token is
// created, and nobody is ever "logged in" as this actor.
//
// Usage:
//   DIRECT_URL=... DATABASE_URL=... pnpm db:bootstrap-admin -- "Name" email@x.com 'password123'
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { createUser } from "../src/lib/services/admin.service";
import { ROLES, type Actor } from "../src/lib/authz";

async function resolveTenantId(): Promise<number> {
  const owner = new PrismaClient({
    datasourceUrl: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
  });
  try {
    const org = await owner.organization.findFirst({ select: { id: true } });
    if (!org) throw new Error("bootstrap-admin: no organization found — run pnpm db:seed:reference first");
    return org.id;
  } finally {
    await owner.$disconnect();
  }
}

async function main() {
  const [name, email, password] = process.argv.slice(2);
  if (!name || !email || !password) {
    throw new Error('usage: pnpm db:bootstrap-admin -- "Name" email@x.com password');
  }

  const tenantId = await resolveTenantId();
  const bootstrapActor: Actor = {
    userId: 0,
    tenantId,
    clientId: null,
    name: "bootstrap",
    email: "bootstrap@local",
    roles: [ROLES.ADMIN],
    departmentIds: [],
  };

  const user = await createUser(bootstrapActor, {
    name,
    email,
    roleCodes: [ROLES.ADMIN],
    departmentIds: [],
    password,
  });
  console.log(`Created ADMIN user ${user.email} (id ${user.id}) in tenant ${tenantId}.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
