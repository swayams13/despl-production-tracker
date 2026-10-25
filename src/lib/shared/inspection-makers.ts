import { jointRefs } from "./floor-rules";

export interface MakerStep {
  seq: number;
  groupCode: string | null;
  jointRef: string | null;
}

/**
 * L1.2g: the WORK steps an INSPECTION step checks, for `inspect` and for the QC queue (one rule, two readers).
 * Its own group's earlier work, on the same joint where it names one. A gate inspection with none there
 * (document and material gates, a clearance at the head of a group) falls back to every earlier WORK step of
 * the unit, so QC cannot accept it before what it clears is recorded. Empty means nothing was built before it:
 * there is no maker to check, and QC accepts alone.
 */
export function inspectionMakers<T extends MakerStep>(step: MakerStep, unitWork: readonly T[]): T[] {
  const before = unitWork.filter((w) => w.seq < step.seq);
  const group = before.filter((w) => w.groupCode === step.groupCode);
  const own = jointRefs(step.jointRef);
  const mine = own.length ? group.filter((w) => jointRefs(w.jointRef).some((j) => own.includes(j))) : group;
  return mine.length ? mine : before;
}
