import type { IntakeOptions, IntakeFamily } from "@/lib/services/job-intake.read";
import type { CreateJobInput } from "@/lib/shared/schemas";

/**
 * J7b: the new-job wizard's state, validation and the draft payload, with no React in it.
 *
 * The state lives in the component, not in the URL (the old wizard kept it in `?s=` and raced fast
 * clicks). Persistence is the draft: `toPayload` is what `saveDraftAction` stores and `fromPayload`
 * reads it back, so a reload or a "Resume" lands on the same screen.
 */

export const PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const PRIORITY_LABEL: Record<string, string> = { LOW: "Low", NORMAL: "Normal", HIGH: "High", URGENT: "Urgent" };

/** Where a line's BOM comes from: nothing yet, a previous job's line, or the equipment type's standard kit. */
export type BomMode = "NONE" | "COPY" | "KIT";

export interface EquipBlockState {
  key: string;
  equipmentTypeId: number | null;
  name: string;
  blockNo: string;
  remarks: string;
  serialPrefix: string;
  serialStart: string;
  serialPad: string;
  serialCount: string;
  serials: string[];
  /** J6: SERIAL = one unit per serial; LOT = one unit carrying `lotQty` pieces. */
  tracking: "SERIAL" | "LOT";
  lotQty: string;
  bomMode: BomMode;
  copyBomFromEquipmentId: number | null;
  /** Set by "Copy a previous job"; the new line's joints start unconfirmed. */
  copyWeldMapFromEquipmentId: number | null;
  /** J3a: a line may run on another published route; carried through a copy, not editable here. */
  templateVersionId: number | null;
}

export interface WizardState {
  step: number;
  maxStep: number;
  clientId: number | null;
  jobNumber: string;
  clientOrderNo: string;
  poRef: string;
  projectName: string;
  orderDate: string;
  committedDeliveryDate: string;
  targetDispatchDate: string;
  priority: Priority;
  calendarId: number | null;
  familyId: number | null;
  versionId: number | null;
  excludedProcessCodes: string[];
  /** Required when excludedProcessCodes is non-empty (AUD-033). */
  exclusionReason: string;
  qcpTemplateSourceId: number | null;
  equipments: EquipBlockState[];
  designCode: string;
  /** Answers to the config questions, as typed; applied to every equipment line (the server keeps each line's own questions). */
  answers: Record<string, string>;
  remarks: string;
}

export const STEP_LABELS = ["Order", "Equipment lines", "Configure", "QC plan", "Schedule and release"];
export const LAST_STEP = STEP_LABELS.length;

export function newBlockKey(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function emptyBlock(bomMode: BomMode = "NONE"): EquipBlockState {
  return {
    key: newBlockKey(),
    equipmentTypeId: null,
    name: "",
    blockNo: "",
    remarks: "",
    serialPrefix: "",
    serialStart: "1",
    serialPad: "2",
    serialCount: "1",
    serials: [""],
    tracking: "SERIAL",
    lotQty: "",
    bomMode,
    copyBomFromEquipmentId: null,
    copyWeldMapFromEquipmentId: null,
    templateVersionId: null,
  };
}

/** `route` "master" (Build from master) starts every new line with its BOM filled from the type's kit. */
export function defaultState(options: IntakeOptions, route: "template" | "master" = "template"): WizardState {
  const defaultCalendar = options.calendars.find((c) => c.isDefault);
  return {
    step: 1,
    maxStep: 1,
    clientId: null,
    jobNumber: "",
    clientOrderNo: "",
    poRef: "",
    projectName: "",
    orderDate: "",
    committedDeliveryDate: "",
    targetDispatchDate: "",
    priority: "NORMAL",
    calendarId: defaultCalendar?.id ?? null,
    familyId: null,
    versionId: null,
    excludedProcessCodes: [],
    exclusionReason: "",
    qcpTemplateSourceId: null,
    equipments: [emptyBlock(route === "master" ? "KIT" : "NONE")],
    designCode: "",
    answers: {},
    remarks: "",
  };
}

export function generateSerials(prefix: string, start: string, pad: string, count: string): string[] {
  const s = Number.parseInt(start, 10) || 1;
  const p = Math.max(0, Number.parseInt(pad, 10) || 0);
  const n = Math.max(0, Number.parseInt(count, 10) || 0);
  return Array.from({ length: n }, (_, i) => `${prefix}${String(s + i).padStart(p, "0")}`);
}

// ── Validation: one reason per step, the same function says "can go on" and "why not" ─────────

export function step1BlockReason(s: Pick<WizardState, "clientId" | "jobNumber" | "committedDeliveryDate" | "targetDispatchDate">): string | null {
  if (!s.clientId) return "Choose the client to continue";
  if (!s.jobNumber.trim()) return "Enter the job number to continue";
  if (!s.committedDeliveryDate) return "Enter the committed delivery date to continue";
  if (s.targetDispatchDate > s.committedDeliveryDate) return "The target dispatch date cannot be after the committed delivery date";
  return null;
}
export function step1Valid(s: WizardState): boolean {
  return step1BlockReason(s) === null;
}

export function step2BlockReason(s: WizardState, families: IntakeFamily[]): string | null {
  const fam = families.find((f) => f.id === s.familyId);
  if (!fam) return "Choose the product family to continue";
  if (!fam.schedulable) return "This family has no published process route yet";
  if (s.versionId == null) return "Choose the process route version to continue";
  if (s.equipments.length === 0) return "Add at least one equipment line";
  for (const [i, e] of s.equipments.entries()) {
    const label = e.name.trim() || `line ${i + 1}`;
    if (!e.name.trim()) return `Give line ${i + 1} a name`;
    if (e.bomMode === "KIT" && e.equipmentTypeId == null) return `Choose the equipment type of ${label} to fill its BOM from the kit`;
    if (e.bomMode === "COPY" && e.copyBomFromEquipmentId == null) return `Choose the job whose BOM ${label} copies, or pick another BOM source`;
    if (e.tracking === "LOT") {
      if (!(Number.isInteger(Number(e.lotQty)) && Number(e.lotQty) > 0)) return `Enter how many pieces are in the lot of ${label}`;
    } else {
      const serials = e.serials.map((x) => x.trim()).filter(Boolean);
      if (serials.length === 0) return `Give ${label} at least one serial number`;
      if (new Set(serials).size !== serials.length) return `The serial numbers of ${label} must be unique`;
    }
  }
  return null;
}

export function step3BlockReason(s: WizardState): string | null {
  if (s.excludedProcessCodes.length > 0 && !s.exclusionReason.trim()) {
    return `Say why ${s.excludedProcessCodes.length} process${s.excludedProcessCodes.length === 1 ? " is" : "es are"} left out`;
  }
  return null;
}

/** Why step `n` cannot be left (null = it can). Steps 4 (QC plan) and 5 have nothing required. */
export function stepBlockReason(n: number, s: WizardState, families: IntakeFamily[]): string | null {
  if (n === 1) return step1BlockReason(s);
  if (n === 2) return step2BlockReason(s, families);
  if (n === 3) return step3BlockReason(s);
  return null;
}
export function stepValid(n: number, s: WizardState, families: IntakeFamily[]): boolean {
  return stepBlockReason(n, s, families) === null;
}
/** Everything the server needs: steps 1 to 3 (4 and 5 are optional). */
export function allValid(s: WizardState, families: IntakeFamily[]): boolean {
  return [1, 2, 3].every((n) => stepValid(n, s, families));
}
/** The first step that is not valid yet; where a resumed draft opens. */
export function resumeStep(s: WizardState, families: IntakeFamily[]): number {
  for (let n = 1; n <= 3; n++) if (!stepValid(n, s, families)) return n;
  return LAST_STEP;
}

// ── The draft payload ───────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

/** JSON-safe createJobSchema input (dates as YYYY-MM-DD, blanks as null). Any part may be unfinished; the server parses it in full only at release. */
export function toPayload(s: WizardState): Json {
  const blank = (x: string) => x.trim() || null;
  return {
    clientId: s.clientId,
    familyId: s.familyId,
    templateVersionId: s.versionId,
    calendarId: s.calendarId,
    jobNumber: s.jobNumber.trim(),
    clientOrderNo: blank(s.clientOrderNo),
    projectName: blank(s.projectName),
    poRef: blank(s.poRef),
    designCode: blank(s.designCode),
    orderDate: s.orderDate || null,
    committedDeliveryDate: s.committedDeliveryDate || null,
    targetDispatchDate: s.targetDispatchDate || null,
    priority: s.priority,
    remarks: blank(s.remarks),
    excludedProcessCodes: s.excludedProcessCodes,
    exclusionReason: s.excludedProcessCodes.length > 0 ? blank(s.exclusionReason) : null,
    qcpTemplateSourceId: s.qcpTemplateSourceId,
    equipments: s.equipments.map((e) => ({
      equipmentTypeId: e.equipmentTypeId,
      ...(e.templateVersionId != null ? { templateVersionId: e.templateVersionId } : {}),
      name: e.name.trim(),
      blockNo: e.blockNo.trim() && Number.isInteger(Number(e.blockNo)) && Number(e.blockNo) > 0 ? Number(e.blockNo) : null,
      remarks: blank(e.remarks),
      config: Object.keys(s.answers).length ? s.answers : null,
      ...(e.bomMode === "COPY" && e.copyBomFromEquipmentId != null ? { copyBomFromEquipmentId: e.copyBomFromEquipmentId } : {}),
      ...(e.bomMode === "KIT" ? { bomFromKit: true } : {}),
      ...(e.copyWeldMapFromEquipmentId != null ? { copyWeldMapFromEquipmentId: e.copyWeldMapFromEquipmentId } : {}),
      ...(e.tracking === "LOT"
        ? { trackingMode: "LOT", lotQty: Number(e.lotQty) || null, serials: [] }
        : { serials: e.serials.map((x) => x.trim()).filter(Boolean) }),
    })),
  };
}

/** The same payload as the typed input `previewJob` and the schema take. */
export function payloadToInput(p: Json): CreateJobInput {
  const date = (x: unknown) => (typeof x === "string" && x ? new Date(x) : null);
  return { ...p, orderDate: date(p.orderDate), committedDeliveryDate: date(p.committedDeliveryDate), targetDispatchDate: date(p.targetDispatchDate) } as unknown as CreateJobInput;
}
export const toInput = (s: WizardState): CreateJobInput => payloadToInput(toPayload(s));

const str = (x: unknown): string => (typeof x === "string" ? x : x == null ? "" : String(x));
const int = (x: unknown): number | null => (typeof x === "number" && Number.isInteger(x) ? x : null);
const dateStr = (x: unknown): string => (typeof x === "string" ? x.slice(0, 10) : "");

/** Read a saved draft back into wizard state. Tolerant: a draft is partial by design. */
export function fromPayload(payload: Json, options: IntakeOptions, route: "template" | "master" = "template"): WizardState {
  const base = defaultState(options, route);
  const lines = Array.isArray(payload.equipments) ? (payload.equipments as Json[]) : [];
  const answers: Record<string, string> = {};
  for (const l of lines) {
    const c = l.config;
    if (c && typeof c === "object") for (const [k, v] of Object.entries(c as Json)) if (v != null && v !== "") answers[k] = String(v);
  }
  const equipments: EquipBlockState[] = lines.map((l) => {
    const serials = Array.isArray(l.serials) ? (l.serials as unknown[]).map(str) : [];
    const copyBom = int(l.copyBomFromEquipmentId);
    const bomMode: BomMode = l.bomFromKit === true ? "KIT" : copyBom != null ? "COPY" : "NONE";
    return {
      ...emptyBlock(bomMode),
      equipmentTypeId: int(l.equipmentTypeId),
      templateVersionId: int(l.templateVersionId),
      name: str(l.name),
      blockNo: l.blockNo == null ? "" : str(l.blockNo),
      remarks: str(l.remarks),
      tracking: l.trackingMode === "LOT" ? "LOT" : "SERIAL",
      lotQty: l.lotQty == null ? "" : str(l.lotQty),
      serials: serials.length ? serials : [""],
      serialCount: String(Math.max(1, serials.length)),
      copyBomFromEquipmentId: copyBom,
      copyWeldMapFromEquipmentId: int(l.copyWeldMapFromEquipmentId),
    };
  });
  // The old job-level copy source fed the first line only.
  const top = int(payload.copyBomFromEquipmentId);
  if (top != null && equipments[0] && equipments[0].bomMode === "NONE") {
    equipments[0].bomMode = "COPY";
    equipments[0].copyBomFromEquipmentId = top;
  }
  return {
    ...base,
    clientId: int(payload.clientId),
    familyId: int(payload.familyId),
    versionId: int(payload.templateVersionId),
    calendarId: payload.calendarId === undefined ? base.calendarId : int(payload.calendarId),
    jobNumber: str(payload.jobNumber),
    clientOrderNo: str(payload.clientOrderNo),
    poRef: str(payload.poRef),
    projectName: str(payload.projectName),
    designCode: str(payload.designCode),
    orderDate: dateStr(payload.orderDate),
    committedDeliveryDate: dateStr(payload.committedDeliveryDate),
    targetDispatchDate: dateStr(payload.targetDispatchDate),
    priority: (PRIORITIES as readonly string[]).includes(str(payload.priority)) ? (payload.priority as Priority) : "NORMAL",
    remarks: str(payload.remarks),
    excludedProcessCodes: Array.isArray(payload.excludedProcessCodes) ? (payload.excludedProcessCodes as unknown[]).map(str) : [],
    exclusionReason: str(payload.exclusionReason),
    qcpTemplateSourceId: int(payload.qcpTemplateSourceId),
    equipments: equipments.length ? equipments : base.equipments,
    answers,
  };
}

/** What the review step says about a line's BOM: follows the real source, not just the chosen mode. */
export function bomSourceLabel(b: EquipBlockState, options: Pick<IntakeOptions, "bomSources" | "equipmentTypes">): string {
  if (b.bomMode === "COPY") {
    if (b.copyBomFromEquipmentId == null) return "Copy chosen, but no previous line picked";
    const src = options.bomSources.find((s) => s.equipmentId === b.copyBomFromEquipmentId);
    return src ? `Copied from ${src.label} (${src.itemCount} ${src.itemCount === 1 ? "line" : "lines"})` : "Nothing to copy: the chosen line has no BOM lines";
  }
  if (b.bomMode === "KIT") {
    const type = options.equipmentTypes.find((t) => t.id === b.equipmentTypeId);
    if (!type) return "Standard kit chosen, but no equipment type picked";
    return type.kit.length ? `From the ${type.name} kit (${type.kit.length} ${type.kit.length === 1 ? "line" : "lines"})` : `The ${type.name} kit is empty: no BOM lines`;
  }
  return "Not started";
}
