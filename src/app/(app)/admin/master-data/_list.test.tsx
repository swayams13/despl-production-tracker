// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PartFamilyList, PartFamilyListRow } from "@/lib/services/master-data.read";

const { refresh, replace, toast, review } = vi.hoisted(() => ({
  refresh: vi.fn(),
  replace: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
  review: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, replace, push: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/app/actions/master-data", () => ({ reviewPartFamiliesAction: (...a: unknown[]) => review(...a) }));

import { MasterDataList } from "./_list";

const row = (id: number, over: Partial<PartFamilyListRow> = {}): PartFamilyListRow => ({
  id, code: `P-${id}`, name: `Part ${id}`, scope: "PV", status: "DRAFT", assemblyGroup: "Shell", makeBuy: null, rawForm: null,
  isSpare: false, variants: ["A"], steps: 3, draftVariants: 1, blockers: 0, warnings: 0, approvedAt: null, canReview: true, ...over,
});
const list = (rows: PartFamilyListRow[], over: Partial<PartFamilyList> = {}): PartFamilyList => ({
  rows, groups: ["Shell"], canEdit: true,
  totals: { all: rows.length, draft: rows.length, reviewed: 0, approved: 0, withBlockers: 0 }, ...over,
});

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("MasterDataList", () => {
  it("offers a checkbox only on rows this person may mark reviewed, and none to a read-only role", () => {
    const { unmount } = render(<MasterDataList filters={{}} list={list([row(1), row(2, { canReview: false })])} />);
    expect((screen.getByLabelText("Select P-1") as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByLabelText("Select P-2") as HTMLInputElement).disabled).toBe(true);
    unmount();

    render(<MasterDataList filters={{}} list={list([row(1, { canReview: false })], { canEdit: false })} />);
    expect(screen.queryByLabelText("Select P-1")).toBeNull();
  });

  it("marks the chosen parts reviewed and reports the ones it had to skip, with their reason", async () => {
    review.mockResolvedValue({
      ok: true,
      reviewed: [1],
      refused: [{ id: 2, code: "MAKER_CHECKER_VIOLATION", message: "The person who last edited a part cannot mark it reviewed." }],
    });
    render(<MasterDataList filters={{}} list={list([row(1), row(2)])} />);
    fireEvent.click(screen.getByLabelText("Select P-1"));
    fireEvent.click(screen.getByLabelText("Select P-2"));
    fireEvent.click(screen.getByRole("button", { name: "Mark reviewed (2)" }));

    await waitFor(() => expect(review).toHaveBeenCalledWith([1, 2]));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("1 marked reviewed, 1 skipped."));
    expect(toast.error).toHaveBeenCalledWith("The person who last edited a part cannot mark it reviewed.");
    expect(refresh).toHaveBeenCalled();
  });

  it("a filter that matches nothing says so and offers to clear it; a truly empty list explains where parts come from", () => {
    const empty = list([], { totals: { all: 0, draft: 0, reviewed: 0, approved: 0, withBlockers: 0 } });
    const a = render(<MasterDataList filters={{ status: "APPROVED" }} list={empty} />);
    expect(screen.getByText("No parts match these filters.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(replace).toHaveBeenCalledWith("/admin/master-data", { scroll: false });
    a.unmount();

    render(<MasterDataList filters={{}} list={empty} />);
    expect(screen.getByText(/No part families have been loaded yet/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
  });

  it("the totals strip filters through the URL", () => {
    render(<MasterDataList filters={{ q: "shell" }} list={list([row(1)], { totals: { all: 5, draft: 2, reviewed: 1, approved: 2, withBlockers: 1 } })} />);
    fireEvent.click(screen.getByRole("button", { name: /Approved/ }));
    expect(replace).toHaveBeenCalledWith("/admin/master-data?q=shell&status=APPROVED", { scroll: false });
    fireEvent.click(screen.getByRole("button", { name: /Need fixes/ }));
    expect(replace).toHaveBeenLastCalledWith("/admin/master-data?q=shell&issues=1", { scroll: false });
  });

  it("shows how much is left to fix per row, not just a status", () => {
    render(<MasterDataList filters={{}} list={list([row(1, { blockers: 2, warnings: 3 })])} />);
    expect(screen.getAllByText("2 to fix").length).toBeGreaterThan(0);
    expect(screen.getAllByText("3 to check").length).toBeGreaterThan(0);
  });
});
