// Lean Core J4a: the planned joints a pressure vessel's shell implies, from its
// answers. Deliberately small: long and circumferential seams from the number of
// shell courses. Nozzle (NS-/NF-), skirt and other attachment joints depend on
// DESPL's weld-map convention (I7) and come from the weld-map import (J4b).
import type { JointType } from "@/generated/prisma/client";

export interface GeneratedJoint {
  jointNo: string;
  jointType: Extract<JointType, "LONG_SEAM" | "CIRC_SEAM">;
  joins: string;
  sortOrder: number;
}

/** The joint types this generator can produce; any other type comes from the weld map. */
export const GENERATED_JOINT_TYPES = ["LONG_SEAM", "CIRC_SEAM"] as const;

export const MAX_SHELL_COURSES = 30;

/**
 * n shell courses → LS-1..LS-n (one long seam per course) and CS-1..CS-(n+1)
 * (n−1 between courses, plus a head-to-shell seam at each end).
 */
export function generateShellJoints(shellCourses: number): GeneratedJoint[] {
  if (!Number.isInteger(shellCourses) || shellCourses < 1 || shellCourses > MAX_SHELL_COURSES) {
    throw new RangeError(`shellCourses must be a whole number from 1 to ${MAX_SHELL_COURSES}`);
  }
  const n = shellCourses;
  const joints: GeneratedJoint[] = [];
  for (let i = 1; i <= n; i++) {
    joints.push({ jointNo: `LS-${i}`, jointType: "LONG_SEAM", joins: `Shell course ${i} long seam`, sortOrder: joints.length });
  }
  for (let k = 1; k <= n + 1; k++) {
    const joins =
      k === 1 ? "First head to shell course 1" : k === n + 1 ? `Shell course ${n} to second head` : `Shell course ${k - 1} to course ${k}`;
    joints.push({ jointNo: `CS-${k}`, jointType: "CIRC_SEAM", joins, sortOrder: joints.length });
  }
  return joints;
}
