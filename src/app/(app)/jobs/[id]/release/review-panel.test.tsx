// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReviewRow } from "@/lib/services/bom-release.read";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/actions/bom-release", () => ({ resolveReviewRowAction: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ReviewPanel } from "./review-panel";

/** J5c: Keep, Replace and Cancel each need a reason; the dialog says so while it is too short. */
const row: ReviewRow = { kind: "COMPONENT_OP", id: 7, unit: "U1", label: "Flange (#1) · Receipt", status: "IN_PROGRESS", sinceRevisionNo: 3, what: ["part family changed"] };

afterEach(cleanup);

describe("ReviewPanel reason", () => {
  it("tells the user why the confirm button is off, and clears the hint once the reason is long enough", () => {
    render(<ReviewPanel jobId={1} rows={[row]} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel row" }));
    const confirm = screen.getAllByRole("button", { name: "Cancel row" }).at(-1) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(screen.getByText(/Write at least 5 characters/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Not needed for this lot" } });
    expect(screen.queryByText(/Write at least 5 characters/)).toBeNull();
    expect(confirm.disabled).toBe(false);
  });
});
