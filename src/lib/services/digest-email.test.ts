import { afterAll, describe, expect, it } from "vitest";
import { subtractWorkingDays } from "@/lib/schedule";
import { DIGEST_RECIPIENT_ROLES, mailerFromEnv, type DigestMessage } from "./digest-email.service";

/**
 * Lean Core L2.11. Pure: the SMTP env switch and the "yesterday" the cron picks.
 * DB-gated: who gets the email, one message each, and the retry guard.
 */
describe("L2.11 mailer and work day (pure)", () => {
  it("mailerFromEnv is null unless SMTP_HOST and SMTP_FROM are both set", () => {
    expect(mailerFromEnv({})).toBeNull();
    expect(mailerFromEnv({ SMTP_HOST: "smtp.example.com" })).toBeNull();
    expect(mailerFromEnv({ SMTP_FROM: "digest@despl.in" })).toBeNull();
    expect(mailerFromEnv({ SMTP_HOST: "  ", SMTP_FROM: "digest@despl.in" })).toBeNull();
    expect(mailerFromEnv({ SMTP_HOST: "smtp.example.com", SMTP_FROM: "digest@despl.in" })?.from).toBe("digest@despl.in");
  });

  it("recipients are management and the production head only", () => {
    expect([...DIGEST_RECIPIENT_ROLES]).toEqual(["MANAGEMENT", "PRODUCTION_HEAD"]);
  });

  it("a Monday digest covers Saturday (Sunday off), a Wednesday covers Tuesday", () => {
    const cal = { weekOffDays: [7], holidays: [] };
    const day = (d: Date) => d.toISOString().slice(0, 10);
    expect(day(subtractWorkingDays(new Date("2027-02-15T00:00:00Z"), 1, cal))).toBe("2027-02-13");
    expect(day(subtractWorkingDays(new Date("2027-02-17T00:00:00Z"), 1, cal))).toBe("2027-02-16");
  });
});

const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("L2.11 morning digest email (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { sendMorningDigest } = await import("./digest-email.service");
  const { loadDigestPayload } = await import("./digest-email.read");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });
  afterAll(() => owner.$disconnect());

  const DATE = "2027-02-11";
  const WORK_DAY = "2027-02-10";
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  async function fixture(label: string) {
    const org = await owner.organization.create({ data: { code: `L211-${label}-${stamp}`, name: `l211 ${label}` } });
    const role = async (code: string) => owner.role.create({ data: { tenantId: org.id, code, name: code } });
    const user = async (name: string, roleCode: string, extra: { active?: boolean; email?: string } = {}) => {
      const u = await owner.user.create({
        data: { tenantId: org.id, email: extra.email ?? `${name}-${label}-${stamp}@despl.test`, username: `${name}-${label}-${stamp}`, name, passwordHash: "x", active: extra.active ?? true },
      });
      await owner.userRole.create({ data: { userId: u.id, roleId: (await roles.get(roleCode)!).id } });
      return u;
    };
    const roles = new Map<string, Promise<{ id: number }>>(["ADMIN", "MANAGEMENT", "PRODUCTION_HEAD", "OPERATOR"].map((c) => [c, role(c)]));
    const admin = await user("admin", "ADMIN");
    const md = await user("md", "MANAGEMENT");
    const ceo = await user("ceo", "MANAGEMENT");
    const sj = await user("sj", "PRODUCTION_HEAD");
    await user("gone", "MANAGEMENT", { active: false });
    await user("op", "OPERATOR");
    await user("noemail", "MANAGEMENT", { email: "" });
    const actor = {
      userId: admin.id, tenantId: org.id, clientId: null, name: "admin", email: admin.email, roles: ["ADMIN" as const],
      departmentIds: [], mustChangePassword: false, themePreference: "SYSTEM" as const, outdoorMode: false,
    };
    return { tenantId: org.id, actor, expected: [md.email, ceo.email, sj.email].sort() };
  }

  const recorder = (failFor?: string) => {
    const sent: DigestMessage[] = [];
    return {
      sent,
      mailer: {
        from: "digest@despl.test",
        send: async (m: DigestMessage) => {
          if (failFor && m.to === failFor) throw new Error("550 mailbox unavailable");
          sent.push(m);
        },
      },
    };
  };

  it("does nothing when SMTP is not configured", async () => {
    const f = await fixture("off");
    const r = await sendMorningDigest({ actor: f.actor, date: DATE, workDay: WORK_DAY, mailer: null });
    expect(r).toEqual({ disabled: true, recipients: 0, sent: 0, skipped: 0, failed: 0 });
    expect(await owner.digestEmail.count({ where: { tenantId: f.tenantId } })).toBe(0);
  });

  it("mails each active management / production-head user once, individually, and records it", async () => {
    const f = await fixture("send");
    const rec = recorder();
    const r = await sendMorningDigest({ actor: f.actor, date: DATE, workDay: WORK_DAY, mailer: rec.mailer, appUrl: "https://tracker.despl.test" });
    expect(r).toMatchObject({ recipients: 3, sent: 3, skipped: 0, failed: 0 });
    expect(rec.sent.map((m) => m.to).sort()).toEqual(f.expected);
    for (const m of rec.sent) {
      expect(m.subject).toMatch(/^DESPL daily — /);
      expect(m.html).toContain("https://tracker.despl.test/dashboard");
      expect(m.from).toBe("digest@despl.test");
    }
    expect(await owner.digestEmail.count({ where: { tenantId: f.tenantId, digestDate: new Date(`${DATE}T00:00:00Z`) } })).toBe(3);
  });

  it("a second run the same day sends nothing", async () => {
    const f = await fixture("again");
    await sendMorningDigest({ actor: f.actor, date: DATE, workDay: WORK_DAY, mailer: recorder().mailer });
    const rec = recorder();
    const r = await sendMorningDigest({ actor: f.actor, date: DATE, workDay: WORK_DAY, mailer: rec.mailer });
    expect(r).toMatchObject({ recipients: 3, sent: 0, skipped: 3, failed: 0 });
    expect(rec.sent).toHaveLength(0);
    // a different day is a new digest
    const next = recorder();
    await sendMorningDigest({ actor: f.actor, date: "2027-02-12", workDay: DATE, mailer: next.mailer });
    expect(next.sent).toHaveLength(3);
  });

  it("one bounced address does not stop the others, and only it is retried", async () => {
    const f = await fixture("bounce");
    const bad = f.expected[0];
    const first = recorder(bad);
    const r1 = await sendMorningDigest({ actor: f.actor, date: DATE, workDay: WORK_DAY, mailer: first.mailer });
    expect(r1).toMatchObject({ sent: 2, failed: 1 });
    expect(first.sent.map((m) => m.to)).not.toContain(bad);
    const retry = recorder();
    const r2 = await sendMorningDigest({ actor: f.actor, date: DATE, workDay: WORK_DAY, mailer: retry.mailer });
    expect(r2).toMatchObject({ sent: 1, skipped: 2, failed: 0 });
    expect(retry.sent.map((m) => m.to)).toEqual([bad]);
  });

  it("keeps tenants apart: the guard rows and the recipients are per tenant", async () => {
    const a = await fixture("ta");
    const b = await fixture("tb");
    await sendMorningDigest({ actor: a.actor, date: DATE, workDay: WORK_DAY, mailer: recorder().mailer });
    const rec = recorder();
    await sendMorningDigest({ actor: b.actor, date: DATE, workDay: WORK_DAY, mailer: rec.mailer });
    expect(rec.sent.map((m) => m.to).sort()).toEqual(b.expected);
  });

  it("the payload for an empty tenant is well-formed", async () => {
    const f = await fixture("payload");
    const p = await loadDigestPayload(f.actor, { date: DATE, workDay: WORK_DAY, appUrl: null });
    expect(p).toMatchObject({
      date: DATE, workDay: WORK_DAY, jobsAtRisk: [], overdueTotal: 0, overdueByDept: [], overrides: [], overridesTotal: 0,
      sameDay: { overall: { same: 0, total: 0, rate: null }, byDept: [] }, appUrl: null,
    });
  });
});
