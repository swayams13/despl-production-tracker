import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "@/lib/authz";
import type { WorkJob, WorkOrg } from "./work.test-util";

/**
 * Pilot friction: Stores saw Verify/Reject on QC items. The UI hides them for non-QC
 * (#119); this pins the server: only QC may verify or reject a SUBMITTED component
 * operation or assembly step, whatever else the actor holds (admins included, invariant 3).
 * Violations first, then the QC positive control so a refusal cannot be a broken fixture.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;
const NON_QC = ["STORES", "OPERATOR", "SUPERVISOR", "PLANNER", "ENGINEERING", "MANAGEMENT", "PRODUCTION_HEAD", "ADMIN"];

describe.skipIf(!RUN_DB)("verify / reject are QC-only (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { makeWorkOrg } = await import("./work.test-util");
  const { verifyComponentOperation, rejectComponentOperation } = await import("./component.service");
  const { verifyAssemblyStep, rejectAssemblyStep } = await import("./assembly.service");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  let o: WorkOrg;
  let j: WorkJob;
  let maker: Actor;
  let qc: Actor;
  const actors = new Map<string, Actor>();
  beforeAll(async () => {
    o = await makeWorkOrg(owner, "VRR");
    j = await o.job({ steps: [{ seq: 1 }], components: [{ tag: "SH-1", pressure: true, ops: [{ code: "CUTTING" }] }] });
    maker = await o.user("maker", ["OPERATOR"]);
    qc = await o.user("qc", ["QC"]);
    for (const r of NON_QC) actors.set(r, await o.user(r.toLowerCase(), [r]));
  });
  afterAll(async () => {
    await owner.$disconnect();
  });

  const opId = () => j.op("SH-1", "CUTTING");
  const stepId = () => j.step(1);
  const submit = async () => {
    await owner.componentOperation.update({ where: { id: opId() }, data: { status: "SUBMITTED", submittedBy: maker.userId } });
    await owner.assemblyStep.update({ where: { id: stepId() }, data: { status: "SUBMITTED", submittedBy: maker.userId } });
  };

  // categoryId is never reached: the role check comes first, so any id does.
  const calls: Array<[string, (a: Actor) => Promise<unknown>]> = [
    ["verify component operation", (a) => verifyComponentOperation(a, { componentOperationId: opId() })],
    ["reject component operation", (a) => rejectComponentOperation(a, { componentOperationId: opId(), categoryId: 1 })],
    ["verify assembly step", (a) => verifyAssemblyStep(a, { assemblyStepId: stepId() })],
    ["reject assembly step", (a) => rejectAssemblyStep(a, { assemblyStepId: stepId(), categoryId: 1 })],
  ];

  for (const [name, call] of calls) {
    it.each(NON_QC)(`${name}: %s is refused and nothing changes`, async (role) => {
      await submit();
      await expect(call(actors.get(role)!)).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect((await owner.componentOperation.findUniqueOrThrow({ where: { id: opId() } })).status).toBe("SUBMITTED");
      expect((await owner.assemblyStep.findUniqueOrThrow({ where: { id: stepId() } })).status).toBe("SUBMITTED");
    });
  }

  it("QC (not the maker) verifies both: the fixture is sound", async () => {
    await submit();
    expect((await verifyComponentOperation(qc, { componentOperationId: opId() })).status).toBe("COMPLETE");
    expect((await verifyAssemblyStep(qc, { assemblyStepId: stepId() })).status).toBe("COMPLETE");
  });
});
