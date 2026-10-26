import { describe, expect, it } from "vitest";
import { renameClient, RenameClientError } from "./rename-client";

/**
 * Client-rename script: violation cases first (empty name, ambiguous match, duplicate name,
 * wrong tenant, unknown actor), then dry run writes nothing and apply writes one audit row.
 * DB-gated, disposable test database. // ponytail: no cleanup, per-run org codes.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("rename-client (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  const org = await owner.organization.create({ data: { code: `TEST-RENAME-${stamp}`, name: "rename" } });
  const otherOrg = await owner.organization.create({ data: { code: `TEST-RENAME-O-${stamp}`, name: "rename other" } });
  const mk = (tenantId: number, name: string) => owner.client.create({ data: { tenantId, name } });
  const a = await mk(org.id, `Unknown client — pending ${stamp}`);
  const b = await mk(org.id, `Unknown client — other ${stamp}`);
  const named = await mk(org.id, `Hindustan Zinc ${stamp}`);
  const foreign = await mk(otherOrg.id, `Foreign ${stamp}`);
  const mkUser = (tenantId: number, tag: string) =>
    owner.user.create({ data: { tenantId, email: `${tag}-${stamp}@x.test`, username: `${tag}-${stamp}`, name: tag, passwordHash: "x", themePreference: "SYSTEM" } });
  const user = await mkUser(org.id, "r");
  const foreignUser = await mkUser(otherOrg.id, "f");

  const audits = (clientId: number) => owner.auditLog.findMany({ where: { tenantId: org.id, entityType: "Client", entityId: String(clientId) } });
  const code = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return e instanceof RenameClientError ? e.code : `other:${e}`;
    }
    return "no error";
  };
  const base = { tenantId: org.id, apply: true };

  it.each([
    ["empty name", { clientId: a.id, name: "   " }, "NAME_EMPTY"],
    ["no selector", { name: "X" }, "NO_SELECTOR"],
    ["ambiguous --match lists both", { match: `Unknown client`, name: "X" }, "AMBIGUOUS"],
    ["no match", { match: "zzz-no-such", name: "X" }, "NOT_FOUND"],
    ["duplicate name, case-insensitive", { clientId: a.id, name: ` hindustan ZINC ${stamp}` }, "NAME_TAKEN"],
    ["client of another tenant", { clientId: foreign.id, name: "Stolen" }, "NOT_FOUND"],
    ["actor from another tenant", { clientId: a.id, name: "Fine Name", actorUserId: foreignUser.id }, "ACTOR_NOT_FOUND"],
  ] as const)("refuses: %s, writes nothing", async (_n, o, want) => {
    expect(await code(renameClient(owner, { ...base, ...o }))).toBe(want);
    expect((await owner.client.findUniqueOrThrow({ where: { id: a.id } })).name).toBe(a.name);
    expect((await owner.client.findUniqueOrThrow({ where: { id: foreign.id } })).name).toBe(foreign.name);
    expect(await audits(a.id)).toHaveLength(0);
  });

  it("ambiguous match message names the candidates", async () => {
    await expect(renameClient(owner, { ...base, match: "unknown client", name: "X" })).rejects.toThrow(new RegExp(`#${a.id}[\\s\\S]*#${b.id}`));
  });

  it("dry run reports before/after and writes nothing", async () => {
    const r = await renameClient(owner, { ...base, apply: false, clientId: a.id, name: `Vedanta ${stamp}` });
    expect(r).toMatchObject({ mode: "DRY_RUN", before: a.name, after: `Vedanta ${stamp}`, auditRows: 0 });
    expect((await owner.client.findUniqueOrThrow({ where: { id: a.id } })).name).toBe(a.name);
    expect(await audits(a.id)).toHaveLength(0);
  });

  it("apply by --match (unique) renames, trims, and writes one audit row with before/after and actor", async () => {
    const r = await renameClient(owner, { ...base, match: `pending ${stamp}`, name: `  Vedanta ${stamp}  `, actorUserId: user.id });
    expect(r).toMatchObject({ mode: "APPLIED", auditRows: 1 });
    expect((await owner.client.findUniqueOrThrow({ where: { id: a.id } })).name).toBe(`Vedanta ${stamp}`);
    const rows = await audits(a.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "client.rename", actorId: user.id, before: { name: a.name } });
    expect(rows[0].after).toMatchObject({ name: `Vedanta ${stamp}` });
  });

  it("a second apply of the same name changes nothing and writes no second audit row", async () => {
    const r = await renameClient(owner, { ...base, clientId: a.id, name: `Vedanta ${stamp}` });
    expect(r.mode).toBe("UNCHANGED");
    expect(await audits(a.id)).toHaveLength(1);
  });
});
