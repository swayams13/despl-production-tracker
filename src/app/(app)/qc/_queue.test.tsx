// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/actions/work", () => ({ inspectAction: vi.fn() }));
vi.mock("@/app/actions/qcp", () => ({ recordQcpEvidenceAction: vi.fn(), approveQcpWaiverAction: vi.fn() }));
vi.mock("@/app/actions/ncr", () => ({ dispositionNcrAction: vi.fn(), ratifyConcessionAction: vi.fn() }));

import { Refused } from "./_queue";

afterEach(cleanup);

describe("QC queue refusal", () => {
  it("shows the plain sentence and never the raw error code", () => {
    render(<Refused k="a" r={{ key: "a", code: "MAKER_CHECKER_VIOLATION", message: "You recorded this work, so another QC user must inspect it." }} />);
    expect(screen.getByRole("alert").textContent).toBe("You recorded this work, so another QC user must inspect it.");
    expect(screen.queryByText("MAKER_CHECKER_VIOLATION")).toBeNull();
  });

  it("shows nothing for another row", () => {
    const { container } = render(<Refused k="b" r={{ key: "a", code: "X", message: "m" }} />);
    expect(container.innerHTML).toBe("");
  });
});
