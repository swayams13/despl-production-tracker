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
import { UNDO_MS, doneLabel, nudgeText, NotifyBlockerButton, RaiseRuleNcrButton, useFloorWrites } from "./floor-actions";

/**
 * Rehearsal finding: after "marked done" the row still showed live Done / Start buttons until the Undo window had passed and
 * the screen had refreshed, so a second tap could repeat the write. The rows a write targets are now busy from the tap until the
 * result is on screen.
 */
const wrapper = ({ children }: { children: ReactNode }) => <LocaleProvider locale="en">{children}</LocaleProvider>;
const hook = () => renderHook(() => useFloorWrites(new Map()), { wrapper });
const ok = () => Promise.resolve({ applied: 1, refused: [] });

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useFloorWrites: busy rows", () => {
  it("a queued write keeps exactly its rows busy during the Undo window; Undo frees them and sends nothing", () => {
    const { result } = hook();
    const send = vi.fn(ok);
    act(() => result.current.queue("Cutting marked done", send, ["COMPONENT_OP:1", "COMPONENT_OP:2"]));

    expect(result.current.busy("COMPONENT_OP:1")).toBe(true);
    expect(result.current.busy("COMPONENT_OP:2")).toBe(true);
    expect(result.current.busy("COMPONENT_OP:3")).toBe(false);
    expect(result.current.busy("ASSEMBLY_STEP:1")).toBe(false); // same id, other kind

    act(() => result.current.undo(result.current.pending[0].id));
    expect(result.current.busy("COMPONENT_OP:1")).toBe(false);
    act(() => void vi.advanceTimersByTime(UNDO_MS + 1000));
    expect(send).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("after the window the write is sent once and the screen refreshed; the rows are free again once that is done", async () => {
    const { result } = hook();
    const send = vi.fn(ok);
    act(() => result.current.queue("Cutting marked done", send, ["COMPONENT_OP:1"]));
    expect(result.current.busy("COMPONENT_OP:1")).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNDO_MS + 10);
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(result.current.pending).toEqual([]); // the Undo card is gone
    expect(result.current.busy("COMPONENT_OP:1")).toBe(false); // the (immediate, mocked) refresh has landed
    expect(result.current.outcomes[0]).toMatchObject({ applied: 1 });
  });

  it("a write with no row keys (the check-in) still sends and refreshes, and marks nothing busy", async () => {
    const { result } = hook();
    const send = vi.fn(ok);
    act(() => result.current.queue("Check-in", send));
    expect(result.current.busy("COMPONENT_OP:1")).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNDO_MS + 10);
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
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

  describe("NotifyBlockerButton after a rule NCR opens, and after a refusal", () => {
    const base = { kind: "ASSEMBLY_STEP" as const, id: 1, refusal: { clearedBy: { role: "QC", label: "QC" } } as never };
    it.each([
      ["no NCR yet", {}, true],
      ["an NCR open (QC's read: ruleNcr.openNcrId)", { ruleNcr: { rule: "H5" as const, openNcrId: 42 } }, false],
      ["an NCR open (everyone else's read: ruleNcrOpen)", { ruleNcr: null, ruleNcrOpen: true }, false],
      ["a rule that applies but no NCR open", { ruleNcr: { rule: "H6" as const, openNcrId: null }, ruleNcrOpen: false }, true],
    ])("%s", (_l, extra, shown) => {
      render(<NotifyBlockerButton unitPublicId="u" row={{ ...base, ...extra }} />, { wrapper });
      expect(screen.queryByRole("button", { name: "Notify QC" }) != null).toBe(shown);
    });

    it("a refusal (the cooldown) shows its reason beside the button, which stays tappable", async () => {
      vi.mocked(notifyBlockerAction).mockResolvedValueOnce({ ok: false, code: "NUDGE_COOLDOWN", message: "QC was told a few minutes ago." } as never);
      render(<NotifyBlockerButton unitPublicId="u" row={base} />, { wrapper });
      await act(async () => screen.getByRole("button", { name: "Notify QC" }).click());
      expect(screen.getByRole("alert").textContent).toBe("QC was told a few minutes ago.");
      expect((screen.getByRole("button", { name: "Notify QC" }) as HTMLButtonElement).disabled).toBe(false);
    });
  });

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
