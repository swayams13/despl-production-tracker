import { describe, expect, it } from "vitest";
import { parseEmployeeCsv, departmentsRequired, buildResultCsv } from "./employee-csv";

const depts = [
  { id: 1, name: "Fabrication" },
  { id: 2, name: "Quality Control / QA" },
];

const header = "displayName,username,email,employeeCode,roles,departments";

describe("departmentsRequired", () => {
  const cases: { roles: string[]; required: boolean }[] = [
    { roles: ["SUPERVISOR"], required: true },
    { roles: ["QC"], required: true },
    { roles: [], required: true },
    { roles: ["MANAGEMENT"], required: false },
    { roles: ["ADMIN"], required: false },
    { roles: ["SUPERVISOR", "MANAGEMENT"], required: false },
  ];
  for (const c of cases) {
    it(`roles=[${c.roles.join(",")}] -> required=${c.required}`, () => {
      expect(departmentsRequired(c.roles)).toBe(c.required);
    });
  }
});

describe("parseEmployeeCsv", () => {
  it("parses a valid row with single role/department", () => {
    const csv = `${header}\nMeera S,meera,meera@despl.local,EMP-01,SUPERVISOR,Fabrication`;
    const rows = parseEmployeeCsv(csv, depts);
    expect(rows).toHaveLength(1);
    expect(rows[0].errors).toEqual([]);
    expect(rows[0].data).toEqual({
      displayName: "Meera S",
      username: "meera",
      email: "meera@despl.local",
      employeeCode: "EMP-01",
      roles: ["SUPERVISOR"],
      departmentIds: [1],
    });
  });

  it("parses multi-value roles/departments separated by |", () => {
    const csv = `${header}\nA B,ab,,,SUPERVISOR|QC,Fabrication|Quality Control / QA`;
    const rows = parseEmployeeCsv(csv, depts);
    expect(rows[0].errors).toEqual([]);
    expect(rows[0].data?.roles).toEqual(["SUPERVISOR", "QC"]);
    expect(rows[0].data?.departmentIds).toEqual([1, 2]);
  });

  it("allows omitted email/employeeCode", () => {
    const csv = `${header}\nA B,ab,,,SUPERVISOR,Fabrication`;
    const rows = parseEmployeeCsv(csv, depts);
    expect(rows[0].errors).toEqual([]);
    expect(rows[0].data?.email).toBeUndefined();
    expect(rows[0].data?.employeeCode).toBeUndefined();
  });

  it("flags a missing displayName", () => {
    const csv = `${header}\n,ab,,,SUPERVISOR,Fabrication`;
    const rows = parseEmployeeCsv(csv, depts);
    expect(rows[0].errors).toContain("Name is required.");
    expect(rows[0].data).toBeUndefined();
  });

  it("flags a missing username", () => {
    const csv = `${header}\nA B,,,,SUPERVISOR,Fabrication`;
    const rows = parseEmployeeCsv(csv, depts);
    expect(rows[0].errors).toContain("Username is required.");
  });

  it("flags an invalid email", () => {
    const csv = `${header}\nA B,ab,not-an-email,,SUPERVISOR,Fabrication`;
    const rows = parseEmployeeCsv(csv, depts);
    expect(rows[0].errors.some((e) => e.includes("not a valid email"))).toBe(true);
  });

  it("flags an unknown role code", () => {
    const csv = `${header}\nA B,ab,,,WELDER,Fabrication`;
    const rows = parseEmployeeCsv(csv, depts);
    expect(rows[0].errors).toContain('"WELDER" is not a valid role.');
  });

  it("flags a missing role", () => {
    const csv = `${header}\nA B,ab,,,,Fabrication`;
    const rows = parseEmployeeCsv(csv, depts);
    expect(rows[0].errors).toContain("At least one role is required.");
  });

  it("flags an unknown department name", () => {
    const csv = `${header}\nA B,ab,,,SUPERVISOR,Nonexistent Dept`;
    const rows = parseEmployeeCsv(csv, depts);
    expect(rows[0].errors).toContain('"Nonexistent Dept" is not a known department.');
  });

  it("requires a department for SUPERVISOR with none given", () => {
    const csv = `${header}\nA B,ab,,,SUPERVISOR,`;
    const rows = parseEmployeeCsv(csv, depts);
    expect(rows[0].errors).toContain("Departments are required unless the role is Management or Admin.");
  });

  it("allows MANAGEMENT with no department", () => {
    const csv = `${header}\nA B,ab,,,MANAGEMENT,`;
    const rows = parseEmployeeCsv(csv, depts);
    expect(rows[0].errors).toEqual([]);
  });

  it("allows ADMIN with no department", () => {
    const csv = `${header}\nA B,ab,,,ADMIN,`;
    const rows = parseEmployeeCsv(csv, depts);
    expect(rows[0].errors).toEqual([]);
  });

  it("matches department names case-insensitively", () => {
    const csv = `${header}\nA B,ab,,,SUPERVISOR,fabrication`;
    const rows = parseEmployeeCsv(csv, depts);
    expect(rows[0].errors).toEqual([]);
    expect(rows[0].data?.departmentIds).toEqual([1]);
  });

  it("skips blank lines and numbers rows by their real source line", () => {
    const csv = `${header}\nA B,ab,,,SUPERVISOR,Fabrication\n\nC D,cd,,,QC,Fabrication`;
    const rows = parseEmployeeCsv(csv, depts);
    expect(rows).toHaveLength(2);
    expect(rows[0].line).toBe(2);
    expect(rows[1].line).toBe(4);
  });

  it("returns no rows for a header-only file", () => {
    expect(parseEmployeeCsv(header, depts)).toEqual([]);
  });

  it("returns no rows for an empty string", () => {
    expect(parseEmployeeCsv("", depts)).toEqual([]);
  });
});

describe("buildResultCsv", () => {
  it("renders created and failed rows, quoting fields that need it", () => {
    const csv = buildResultCsv([
      { line: 2, displayName: "Meera S", username: "meera", ok: true, tempPassword: "granite-falcon-summit-07", effectiveEmail: "meera@despl.local" },
      { line: 3, displayName: "Bad, Row", username: "bad", ok: false, error: 'A user with this username already exists.' },
    ]);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("line,displayName,username,status,tempPassword,effectiveEmail,error");
    expect(lines[1]).toBe("2,Meera S,meera,created,granite-falcon-summit-07,meera@despl.local,");
    expect(lines[2]).toBe('3,"Bad, Row",bad,failed,,,A user with this username already exists.');
  });
});
