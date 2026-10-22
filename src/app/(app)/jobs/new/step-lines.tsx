"use client";

import Link from "next/link";
import { plural } from "@/lib/shared/plural";
import type { IntakeOptions, IntakeFamily } from "@/lib/services/job-intake.read";
import { emptyBlock, generateSerials, type BomMode, type EquipBlockState, type WizardState } from "./wizard-state";

const BOM_MODES: Array<{ value: BomMode; label: string }> = [
  { value: "NONE", label: "No BOM yet: start it on the release screen" },
  { value: "COPY", label: "Copy the BOM of a previous job" },
  { value: "KIT", label: "Fill from the equipment type's standard kit" },
];

/** Frame 13B: the family and route, then one card per equipment line. */
export function StepLines({
  state,
  patch,
  options,
  family,
  onSelectFamily,
  onSelectVersion,
}: {
  state: WizardState;
  patch: (p: Partial<WizardState>) => void;
  options: IntakeOptions;
  family: IntakeFamily | null;
  onSelectFamily: (f: IntakeFamily) => void;
  onSelectVersion: (versionId: number) => void;
}) {
  const typesForFamily = options.equipmentTypes.filter((t) => t.familyId === state.familyId);
  const version = family?.versions.find((v) => v.id === state.versionId) ?? null;

  const updateBlock = (key: string, fn: (b: EquipBlockState) => EquipBlockState) => {
    patch({ equipments: state.equipments.map((b) => (b.key === key ? fn(b) : b)) });
  };
  const addBlock = () => patch({ equipments: [...state.equipments, emptyBlock(state.equipments.every((b) => b.bomMode === "KIT") ? "KIT" : "NONE")] });
  const removeBlock = (key: string) => patch({ equipments: state.equipments.filter((b) => b.key !== key) });

  const selectEquipmentType = (key: string, typeId: number | null) => {
    const type = options.equipmentTypes.find((t) => t.id === typeId) ?? null;
    updateBlock(key, (b) => ({ ...b, equipmentTypeId: typeId, name: type ? type.name : b.name }));
    if (type) {
      patch({
        designCode: type.defaultDesignCode ?? state.designCode,
        answers: type.defaultSpecs
          ? Object.fromEntries(Object.entries(type.defaultSpecs).map(([k, v]) => [k, String(v)]))
          : state.answers,
      });
    }
  };

  return (
    <>
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="hd"><h3>Product family and route</h3></div>
        <div style={{ padding: 16 }}>
          <div className="dept-grid">
            {options.families.map((f) => {
              const selected = state.familyId === f.id;
              return (
                <div
                  key={f.id}
                  className={`fam-card ${f.schedulable ? "pickable" : "disabled"} ${selected ? "sel" : ""}`}
                  role={f.schedulable ? "button" : undefined}
                  tabIndex={f.schedulable ? 0 : undefined}
                  aria-pressed={f.schedulable ? selected : undefined}
                  onClick={() => onSelectFamily(f)}
                  onKeyDown={(e) => { if (f.schedulable && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onSelectFamily(f); } }}
                >
                  <h4>{f.name}</h4>
                  {f.schedulable ? (
                    <div className="rep">{f.versions.length} route version{f.versions.length === 1 ? "" : "s"} available</div>
                  ) : (
                    <div className="rep" style={{ color: "var(--s-hold)" }}>
                      No process route defined yet. <Link href="/admin/templates">Set one up →</Link>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {options.families.length === 0 && <p className="note" style={{ textAlign: "left" }}>No product family is set up yet. <Link href="/admin/families">Add one</Link> first.</p>}
          {family && (
            <div style={{ marginTop: 14 }}>
              <label className="emp-hint" style={{ display: "block", marginBottom: 4 }} htmlFor="route-version">Process route version</label>
              <select
                id="route-version"
                className="ws-detail"
                value={state.versionId ?? ""}
                onChange={(e) => onSelectVersion(Number(e.target.value))}
                style={{ maxWidth: 460 }}
              >
                {family.versions.map((v) => (
                  <option key={v.id} value={v.id}>{v.templateName} v{v.version}: {v.processCount} processes</option>
                ))}
              </select>
              {version && version.provisionalCount > 0 && (
                <div className="chip c-hold" style={{ marginTop: 10 }}>
                  <i />{version.provisionalCount} process{version.provisionalCount === 1 ? "" : "es"} have no confirmed duration, so this job will not produce dates yet.
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {state.equipments.map((b, idx) => {
        const type = options.equipmentTypes.find((t) => t.id === b.equipmentTypeId) ?? null;
        const knownSource = options.bomSources.some((s) => s.equipmentId === b.copyBomFromEquipmentId);
        return (
          <div className="card" style={{ marginBottom: 14 }} key={b.key}>
            <div className="hd">
              <h3>Equipment line {idx + 1}</h3>
              {state.equipments.length > 1 && (
                <button className="btn" style={{ marginLeft: "auto" }} onClick={() => removeBlock(b.key)}>Remove</button>
              )}
            </div>
            <div style={{ padding: 16 }}>
              <div className="emp-grid">
                <div>
                  <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>Equipment type</label>
                  <select
                    className="ws-detail"
                    value={b.equipmentTypeId ?? ""}
                    onChange={(e) => selectEquipmentType(b.key, e.target.value ? Number(e.target.value) : null)}
                    disabled={!family}
                  >
                    <option value="">{family ? "Select equipment type…" : "Choose a family first"}</option>
                    {typesForFamily.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>Block name *</label>
                  <input className="ws-detail" value={b.name} onChange={(e) => updateBlock(b.key, (x) => ({ ...x, name: e.target.value }))} />
                </div>
                <div>
                  <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>Block number</label>
                  <input className="ws-detail" type="number" min={1} value={b.blockNo} onChange={(e) => updateBlock(b.key, (x) => ({ ...x, blockNo: e.target.value }))} />
                </div>
                <div>
                  <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>Remarks</label>
                  <input className="ws-detail" value={b.remarks} onChange={(e) => updateBlock(b.key, (x) => ({ ...x, remarks: e.target.value }))} />
                </div>
              </div>

            <div className="sh-sec">How it is tracked</div>
            <div className="emp-grid" style={{ gridTemplateColumns: "1fr 1fr", marginBottom: 10 }}>
              <div>
                <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>Tracking</label>
                <select
                  className="ws-detail"
                  value={b.tracking}
                  onChange={(e) => updateBlock(b.key, (x) => ({ ...x, tracking: e.target.value as "SERIAL" | "LOT" }))}
                >
                  <option value="SERIAL">Serial units: each one has its own serial number</option>
                  <option value="LOT">One lot: counted, not serialised</option>
                </select>
              </div>
              {b.tracking === "LOT" && (
                <div>
                  <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>Pieces in the lot *</label>
                  <input
                    className="ws-detail"
                    type="number"
                    min={1}
                    value={b.lotQty}
                    onChange={(e) => updateBlock(b.key, (x) => ({ ...x, lotQty: e.target.value }))}
                  />
                </div>
              )}
            </div>
            {b.tracking === "SERIAL" && (<>
            <div className="sh-sec">Serial scheme</div>
            <div className="emp-grid" style={{ gridTemplateColumns: "1fr 1fr 1fr 1fr" }}>
              <div>
                <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>Prefix</label>
                <input
                  className="ws-detail"
                  value={b.serialPrefix}
                  placeholder="e.g. 320SR"
                  onChange={(e) => updateBlock(b.key, (x) => ({ ...x, serialPrefix: e.target.value, serials: generateSerials(e.target.value, x.serialStart, x.serialPad, x.serialCount) }))}
                />
              </div>
              <div>
                <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>Start</label>
                <input
                  className="ws-detail"
                  type="number"
                  min={0}
                  value={b.serialStart}
                  onChange={(e) => updateBlock(b.key, (x) => ({ ...x, serialStart: e.target.value, serials: generateSerials(x.serialPrefix, e.target.value, x.serialPad, x.serialCount) }))}
                />
              </div>
              <div>
                <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>Pad width</label>
                <input
                  className="ws-detail"
                  type="number"
                  min={0}
                  max={6}
                  value={b.serialPad}
                  onChange={(e) => updateBlock(b.key, (x) => ({ ...x, serialPad: e.target.value, serials: generateSerials(x.serialPrefix, x.serialStart, e.target.value, x.serialCount) }))}
                />
              </div>
              <div>
                <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>Quantity</label>
                <input
                  className="ws-detail"
                  type="number"
                  min={1}
                  value={b.serialCount}
                  onChange={(e) => updateBlock(b.key, (x) => ({ ...x, serialCount: e.target.value, serials: generateSerials(x.serialPrefix, x.serialStart, x.serialPad, e.target.value) }))}
                />
              </div>
            </div>

            <div className="emp-hint" style={{ marginTop: 10 }}>
              {b.serials.length} serial{b.serials.length === 1 ? "" : "s"} — each editable below
            </div>
            <div className="serial-row">
              {b.serials.map((serial, i) => (
                <input
                  key={i}
                  className="ws-detail mono"
                  value={serial}
                  onChange={(e) => updateBlock(b.key, (x) => {
                    const serials = [...x.serials];
                    serials[i] = e.target.value;
                    return { ...x, serials };
                  })}
                />
              ))}
            </div>
            {new Set(b.serials.map((s) => s.trim())).size !== b.serials.map((s) => s.trim()).filter(Boolean).length && (
              <div className="ws-err">Serial numbers must be unique within this block.</div>
            )}
            </>)}
              <div className="sh-sec">Bill of materials</div>
              <select
                className="ws-detail"
                style={{ maxWidth: 460 }}
                aria-label={`BOM source for line ${idx + 1}`}
                value={b.bomMode}
                onChange={(e) => updateBlock(b.key, (x) => ({ ...x, bomMode: e.target.value as BomMode }))}
              >
                {BOM_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
              {b.bomMode === "COPY" && (
                <div style={{ marginTop: 8 }}>
                  <select
                    className="ws-detail"
                    style={{ maxWidth: 460 }}
                    aria-label={`Job to copy the BOM of line ${idx + 1} from`}
                    value={b.copyBomFromEquipmentId ?? ""}
                    onChange={(e) => updateBlock(b.key, (x) => ({ ...x, copyBomFromEquipmentId: e.target.value ? Number(e.target.value) : null }))}
                  >
                    <option value="">Choose a previous line…</option>
                    {!knownSource && b.copyBomFromEquipmentId != null && <option value={b.copyBomFromEquipmentId}>The copied job&apos;s line (it has no BOM lines)</option>}
                    {options.bomSources.map((s) => (
                      <option key={s.equipmentId} value={s.equipmentId}>{s.label}: {plural(s.itemCount, "item")}</option>
                    ))}
                  </select>
                  {options.bomSources.length === 0 && <div className="emp-hint">No earlier job has BOM lines to copy.</div>}
                  {b.copyWeldMapFromEquipmentId != null && <div className="emp-hint">The weld map comes from the same earlier line. Every joint starts unconfirmed.</div>}
                </div>
              )}
              {b.bomMode === "KIT" && (
                <div style={{ marginTop: 8 }}>
                  {!type ? (
                    <p className="note" style={{ textAlign: "left", margin: 0 }}>Choose the equipment type above to see its standard kit.</p>
                  ) : type.kit.length === 0 ? (
                    <p className="note" style={{ textAlign: "left", margin: 0 }}>
                      {type.name} has no standard kit yet. The line will start with an empty BOM; add lines on the release screen, or set up the kit under <Link href="/admin/equipment-types">Equipment types</Link>.
                    </p>
                  ) : (
                    <>
                      <div className="emp-hint">{plural(type.kit.length, "line")} from the {type.name} kit go into the BOM as a draft. Engineering checks them and releases the BOM.</div>
                      <table>
                        <thead><tr><th>Component type</th><th className="num">Quantity</th></tr></thead>
                        <tbody>
                          {type.kit.map((k) => (
                            <tr className="row" key={k.name}>
                              <td>{k.name}</td>
                              <td className="num mono">{k.qty}{k.qtySource !== "FIXED" && <span className="emp-hint"> (from the answers)</span>}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
      <button className="btn" onClick={addBlock}>+ Add another equipment line</button>
    </>
  );
}
