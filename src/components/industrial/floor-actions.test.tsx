// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/app/actions/work", () => ({ ensureJointAction: vi.fn(), notifyBlockerAction: vi.fn(), recordWorkAction: vi.fn() }));
vi.mock("@/app/actions/heat", () => ({ loadHeatChoicesAction: vi.fn(), pickHeatNumberAction: vi.fn() }));

import { LocaleProvider } from "@/lib/i18n/provider";
import { UNDO_MS, useFloorWrites } from "./floor-actions";

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
