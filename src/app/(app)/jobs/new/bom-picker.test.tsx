// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BomPicker } from "./bom-picker";
import type { PickerEntry } from "./bom-picker-entries";

const entries: PickerEntry[] = [
  { kind: "KIT", key: "kit:1", typeId: 1, title: "Vertical vessel", sub: "Standard kit · 2 lines", haystack: "vertical vessel standard kit shell" },
  { kind: "TYPE", key: "type:2", typeId: 2, title: "Heat shield", sub: "Equipment type · no standard kit yet", haystack: "heat shield" },
  { kind: "SOURCE", key: "src:10", equipmentId: 10, title: "Air receiver", sub: "DESPL-320 · Acme Gas · 29 lines", haystack: "air receiver despl-320 acme gas" },
];

afterEach(cleanup);
const setup = (props: Partial<React.ComponentProps<typeof BomPicker>> = {}) => {
  const onPick = vi.fn();
  render(<BomPicker entries={entries} summary="" label="Pick" onPick={onPick} {...props} />);
  return { onPick, box: screen.getByRole("combobox", { name: "Pick" }) as HTMLInputElement };
};

describe("BomPicker", () => {
  it("opens on focus with every entry, grouped, and filters as you type", () => {
    const { box } = setup();
    fireEvent.focus(box);
    expect(screen.getAllByRole("option")).toHaveLength(3);
    expect(screen.getByRole("group", { name: "Equipment types" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "BOMs from earlier jobs" })).toBeTruthy();
    fireEvent.change(box, { target: { value: "despl-320" } });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Air receiverDESPL-320 · Acme Gas · 29 lines"]);
  });

  it("chooses with the keyboard: arrows move, Enter picks, Escape closes", () => {
    const { box, onPick } = setup();
    fireEvent.focus(box);
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(box.getAttribute("aria-activedescendant")).toContain("src:10");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith(entries[2]);
    expect(screen.queryByRole("listbox")).toBeNull();

    fireEvent.focus(box);
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it("wraps from the first entry up to the last", () => {
    const { box, onPick } = setup();
    fireEvent.focus(box);
    fireEvent.keyDown(box, { key: "ArrowUp" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith(entries[2]);
  });

  it("chooses with a click", () => {
    const { box, onPick } = setup();
    fireEvent.focus(box);
    fireEvent.click(screen.getByRole("option", { name: /Heat shield/ }));
    expect(onPick).toHaveBeenCalledWith(entries[1]);
  });

  it("says so when nothing matches, and Enter then picks nothing", () => {
    const { box, onPick } = setup();
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "zzz" } });
    expect(screen.getByText(/Nothing matches/)).toBeTruthy();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onPick).not.toHaveBeenCalled();
  });

  it("says so when the family has nothing to offer", () => {
    const { box } = setup({ entries: [] });
    fireEvent.focus(box);
    expect(screen.getByText(/No equipment types or earlier BOMs/)).toBeTruthy();
  });

  it("is disabled, with its hint, until a family is chosen", () => {
    const { box } = setup({ disabled: true, disabledHint: "Choose a family first" });
    expect(box.disabled).toBe(true);
    expect(box.placeholder).toBe("Choose a family first");
    fireEvent.focus(box);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("shows the current choice when closed", () => {
    const { box } = setup({ summary: "Air receiver · DESPL-320" });
    expect(box.value).toBe("Air receiver · DESPL-320");
  });
});
