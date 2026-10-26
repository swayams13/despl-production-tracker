// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/app/actions/work", () => ({ ensureJointAction: vi.fn(), notifyBlockerAction: vi.fn(), recordWorkAction: vi.fn(), raiseRuleNcrAction: vi.fn() }));
vi.mock("@/app/actions/heat", () => ({ loadHeatChoicesAction: vi.fn(), pickHeatNumberAction: vi.fn() }));

import { LocaleProvider } from "@/lib/i18n/provider";
import { notifyBlockerAction, raiseRuleNcrAction } from "@/app/actions/work";
import { en } from "@/lib/i18n/en";
import { hi } from "@/lib/i18n/hi";
import { doneLabel, nudgeText, NotifyBlockerButton, RaiseRuleNcrButton, useFloorWrites } from "./floor-actions";

/**
 * Writes go out on tap (no Undo, 26 Oct 2026). The rows a write targets are busy from the tap until the result is on screen, so
 * a second tap cannot repeat it; with no connection the outcome says "Not sent" and Try again resends the same write.
 */
const wrapper = ({ children }: { children: ReactNode }) => <LocaleProvider locale="en">{children}</LocaleProvider>;
const hook = () => renderHook(() => useFloorWrites(new Map()), { wrapper });
const ok = () => Promise.resolve({ applied: 1, refused: [] });

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
});

describe("useFloorWrites: send on tap", () => {
  it("sends at once, keeps exactly its rows busy while in flight, frees them once the screen has refreshed", async () => {
    const { result } = hook();
    let finish!: (r: { applied: number; refused: [] }) => void;
    const send = vi.fn(() => new Promise<{ applied: number; refused: [] }>((r) => (finish = r)));
    act(() => result.current.commit("Cutting marked done", send, ["COMPONENT_OP:1", "COMPONENT_OP:2"]));

    expect(send).toHaveBeenCalledTimes(1); // no delay
    expect(result.current.busy("COMPONENT_OP:1")).toBe(true);
    expect(result.current.busy("COMPONENT_OP:2")).toBe(true);
    expect(result.current.busy("COMPONENT_OP:3")).toBe(false);
    expect(result.current.busy("ASSEMBLY_STEP:1")).toBe(false); // same id, other kind
    expect(refresh).not.toHaveBeenCalled();

    await act(async () => finish({ applied: 1, refused: [] }));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(result.current.busy("COMPONENT_OP:1")).toBe(false); // the (immediate, mocked) refresh has landed
    expect(result.current.outcomes[0]).toMatchObject({ applied: 1 });
  });

  it("a write with no row keys (the check-in) still sends and refreshes, and marks nothing busy", async () => {
    const { result } = hook();
    const send = vi.fn(ok);
    await act(async () => result.current.commit("Check-in", send));
    expect(result.current.busy("COMPONENT_OP:1")).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("a refused row keeps its reason on the card and frees the rows", async () => {
    const { result } = hook();
    const send = vi.fn(() => Promise.resolve({ applied: 0, refused: [{ kind: "COMPONENT_OP" as const, id: 1, message: "Hold point open" }] }));
    await act(async () => result.current.commit("Cutting marked done", send, ["COMPONENT_OP:1"]));
    expect(result.current.outcomes[0].refused).toHaveLength(1);
    expect(result.current.outcomes[0].refused[0].message).toBe("Hold point open");
    expect(result.current.busy("COMPONENT_OP:1")).toBe(false);
  });

  it("no connection: the card says not sent, the rows are free, and Try again sends the same write once more", async () => {
    const { result } = hook();
    const send = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockImplementation(ok);
    await act(async () => result.current.commit("Cutting marked done", send, ["COMPONENT_OP:1"]));

    const failed = result.current.outcomes[0];
    expect(failed.error).toBe(en.outcome.noConnection);
    expect(failed.retry).toBeTypeOf("function");
    expect(result.current.busy("COMPONENT_OP:1")).toBe(false);
    // Walkthrough finding: with no connection the refresh fails too and Next reloads the page, losing this card. No refresh after a failed send.
    expect(refresh).not.toHaveBeenCalled();

    await act(async () => failed.retry!());
    expect(send).toHaveBeenCalledTimes(2); // same closure, so the same requestId: the server replays rather than repeats
    expect(refresh).toHaveBeenCalledTimes(1); // the retry went through, so now the screen refreshes
    expect(result.current.outcomes).toHaveLength(1);
    expect(result.current.outcomes[0]).toMatchObject({ applied: 1, error: undefined });
  });
});

describe("floor messages (rehearsal polish)", () => {
  it("nudge: nobody holds the role -> says so plainly; someone does -> told", () => {
    expect(nudgeText(en, "Stores", 0)).toBe("Nobody is set up for Stores yet. Ask the Production Head.");
    expect(nudgeText(en, "Stores", 2)).toBe("Stores has been told.");
    expect(nudgeText(hi, "Stores", 0)).not.toBe(nudgeText(hi, "Stores", 1));
  });

  it("Done: a step QC must verify says sent to QC; one that completed directly says marked done", () => {
    expect(doneLabel(en, "Fit-up", 1, [{ to: "SUBMITTED" }])).toBe("Fit-up sent to QC");
    expect(doneLabel(en, "Fit-up", 3, [{ to: "SUBMITTED" }, { to: "SUBMITTED" }, { to: "SUBMITTED" }])).toBe("Fit-up sent to QC on 3 units");
    expect(doneLabel(en, "Fit-up", 1, [{ to: "COMPLETE" }])).toBe("Fit-up marked done");
    expect(doneLabel(en, "Fit-up", 2, [{ to: "SUBMITTED" }, { to: "COMPLETE" }])).toBe("Fit-up marked done on 2 units");
    expect(doneLabel(en, "Fit-up", 1, [])).toBe("Fit-up marked done");
  });

  const row = { kind: "ASSEMBLY_STEP" as const, id: 1, refusal: { clearedBy: { role: "STORES", label: "Stores" } } as never };
  it.each([[0, "Nobody is set up for Stores yet. Ask the Production Head."], [2, "Stores has been told."]])(
    "Notify button with %i recipients shows its message",
    async (recipients, text) => {
      vi.mocked(notifyBlockerAction).mockResolvedValueOnce({ ok: true, recipients });
      render(<NotifyBlockerButton unitPublicId="u" row={row} />, { wrapper });
      await act(async () => screen.getByRole("button", { name: "Notify Stores" }).click());
      expect(screen.getByRole("button").textContent).toBe(text);
    },
  );

  // L1.2i: QC raises the H5/H6 NCR from the refused row. Violations first.
  describe("RaiseRuleNcrButton", () => {
    const refused = { kind: "ASSEMBLY_STEP" as const, id: 7, ruleNcr: { rule: "H5" as const, openNcrId: null } };

    it("renders nothing for a row no rule NCR applies to", () => {
      const { container } = render(<RaiseRuleNcrButton row={{ ...refused, ruleNcr: null }} />, { wrapper });
      expect(container.textContent).toBe(""); // the locale wrapper is an empty div
      expect(container.querySelector("button, a")).toBeNull();
    });

    it("an NCR already open shows it and offers no second button", () => {
      render(<RaiseRuleNcrButton row={{ ...refused, ruleNcr: { rule: "H5", openNcrId: 42 } }} />, { wrapper });
      expect(screen.queryByRole("button")).toBeNull();
      expect(screen.getByRole("link", { name: /NCR open/ }).getAttribute("href")).toBe("/qc?tab=ncrs");
    });

    it("a refusal shows the server's message and the button stays tappable", async () => {
      vi.mocked(raiseRuleNcrAction).mockResolvedValueOnce({ ok: false, code: "VALIDATION_FAILED", message: "H5 does not refuse this item now." } as never);
      render(<RaiseRuleNcrButton row={refused} />, { wrapper });
      await act(async () => screen.getByRole("button", { name: "Raise NCR (H5)" }).click());
      expect(screen.getByText("H5 does not refuse this item now.")).toBeTruthy();
      expect((screen.getByRole("button", { name: "Raise NCR (H5)" }) as HTMLButtonElement).disabled).toBe(false);
      expect(refresh).not.toHaveBeenCalled();
    });

    it("sends the row's kind, id and rule once, then says it is raised and refreshes the screen", async () => {
      vi.mocked(raiseRuleNcrAction).mockResolvedValueOnce({ ok: true, result: { ncrId: 5 } });
      render(<RaiseRuleNcrButton row={{ ...refused, kind: "COMPONENT_OP", id: 9, ruleNcr: { rule: "H6", openNcrId: null } }} />, { wrapper });
      await act(async () => screen.getByRole("button", { name: "Raise NCR (H6)" }).click());
      expect(raiseRuleNcrAction).toHaveBeenCalledTimes(1);
      expect(raiseRuleNcrAction).toHaveBeenCalledWith({ kind: "COMPONENT_OP", targetId: 9, rule: "H6" });
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(screen.getByText("NCR raised")).toBeTruthy();
      expect(screen.queryByRole("button")).toBeNull();
    });
  });
});
