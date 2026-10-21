import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: vi.fn(), usePathname: vi.fn(), useSearchParams: vi.fn() }));
vi.mock("@/app/actions/job-intake", () => ({}));

const { step1Valid } = await import("./_client");

const ok = {
  clientId: 1,
  jobNumber: "DESPL-321",
  committedDeliveryDate: "2026-12-31",
  targetDispatchDate: "",
} as unknown as Parameters<typeof step1Valid>[0];

describe("wizard step 1 validity", () => {
  it.each([
    ["no client", { clientId: null }],
    ["blank job number", { jobNumber: "  " }],
    ["blank committed delivery date", { committedDeliveryDate: "" }],
    ["dispatch after delivery", { targetDispatchDate: "2027-01-05" }],
  ])("%s blocks Next", (_n, patch) => {
    expect(step1Valid({ ...ok, ...patch })).toBe(false);
  });

  it("client, number and delivery date pass", () => {
    expect(step1Valid(ok)).toBe(true);
  });
});
