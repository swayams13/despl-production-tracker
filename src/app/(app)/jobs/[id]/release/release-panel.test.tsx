// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { BomReleasePreview } from "@/lib/services/bom-release.service";
import { ReleasePanel, releaseBlocker } from "./release-panel";

/**
 * J5b: the warnings and their single acknowledgement. Release stays off until the box is ticked,
 * stays off while the mapping is unsaved, and does not exist at all for a role that cannot release.
 */
const counts = { components: 6, operations: 8, steps: 20, stepsByScope: { PER_UNIT: 4, PER_JOINT: 6 }, boundToQcp: 2, unmappedLines: 0, ruleDecisions: 3 };
const warning = { code: "NO_QCP" as const, message: "This job has no QC plan.", items: [] };
const preview = (over: Partial<BomReleasePreview> = {}): BomReleasePreview => ({
  equipment: { id: 1, name: "Vessel", units: 2 },
  revision: { id: 5, revisionNo: 1, status: "DRAFT", materializedAt: null },
  state: "READY",
  lines: [],
  refusals: [],
  warnings: [],
  counts,
  ...over,
});
const button = () => screen.queryByRole("button", { name: /Release revision 1/ }) as HTMLButtonElement | null;

afterEach(cleanup);

describe("releaseBlocker", () => {
  it.each([
    [{ state: "READY", dirty: false, warnings: 0, acknowledged: false }, null],
    [{ state: "READY", dirty: false, warnings: 2, acknowledged: true }, null],
    [{ state: "READY", dirty: false, warnings: 2, acknowledged: false }, /checked the warnings/],
    [{ state: "READY", dirty: true, warnings: 0, acknowledged: false }, /Save the mapping/],
    [{ state: "REFUSED", dirty: false, warnings: 0, acknowledged: true }, /cannot be released/],
    [{ state: "ALREADY_RELEASED", dirty: false, warnings: 0, acknowledged: true }, /cannot be released/],
  ] as const)("%j", (input, expected) => {
    const r = releaseBlocker(input);
    if (expected === null) expect(r).toBeNull();
    else expect(r).toMatch(expected);
  });
});

describe("ReleasePanel", () => {
  it("with no warnings Release is on and sends acknowledged = false", () => {
    const onRelease = vi.fn();
    render(<ReleasePanel preview={preview()} canRelease dirty={false} busy={false} onRelease={onRelease} />);
    expect(button()!.disabled).toBe(false);
    fireEvent.click(button()!);
    expect(onRelease).toHaveBeenCalledWith(false);
  });

  it("with warnings Release is off until the one box is ticked, then sends acknowledged = true", () => {
    const onRelease = vi.fn();
    render(<ReleasePanel preview={preview({ warnings: [warning, { ...warning, code: "WELD_MAP_UNCONFIRMED", message: "3 joints are not confirmed." }] })} canRelease dirty={false} busy={false} onRelease={onRelease} />);
    expect(screen.getByText("This job has no QC plan.")).toBeTruthy();
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    expect(button()!.disabled).toBe(true);
    fireEvent.click(button()!);
    expect(onRelease).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(button()!.disabled).toBe(false);
    fireEvent.click(button()!);
    expect(onRelease).toHaveBeenCalledWith(true);
  });

  it("an unsaved mapping turns Release off and says why, even with the box ticked", () => {
    render(<ReleasePanel preview={preview({ warnings: [warning] })} canRelease dirty busy={false} onRelease={vi.fn()} />);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(button()!.disabled).toBe(true);
    expect(screen.getByText(/Save the mapping first/)).toBeTruthy();
  });

  it("a role that cannot release sees no Release button and the reason", () => {
    render(<ReleasePanel preview={preview()} canRelease={false} dirty={false} busy={false} onRelease={vi.fn()} />);
    expect(button()).toBeNull();
    expect(screen.getByText(/Engineering, the Production Head and Admins release the BOM/)).toBeTruthy();
  });

  it("a revision that is already released shows its counts and no Release button", () => {
    render(<ReleasePanel preview={preview({ state: "ALREADY_RELEASED", revision: { id: 5, revisionNo: 1, status: "RELEASED", materializedAt: new Date() } })} canRelease dirty={false} busy={false} onRelease={vi.fn()} />);
    expect(button()).toBeNull();
    expect(screen.getByText("Revision 1 is released")).toBeTruthy();
    expect(screen.getByText("Assembly steps").nextSibling?.textContent).toBe("20");
  });

  it("a refused revision has no counts and no Release button", () => {
    render(<ReleasePanel preview={preview({ state: "REFUSED", counts: null })} canRelease dirty={false} busy={false} onRelease={vi.fn()} />);
    expect(button()).toBeNull();
    expect(screen.getByText(/Nothing to show until the revision can be released/)).toBeTruthy();
  });
});
