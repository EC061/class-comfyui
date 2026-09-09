import { describe, it, expect } from "vitest";
import { parseRosterCsv, reconcileRoster } from "../../packages/auth/src/roster";

describe("roster parser", () => {
  it("parses valid university CSV, strips leading #", () => {
    const csv = `OrgDefinedId,Last Name,First Name,Email,End-of-Line Indicator\n#811883567,Yedla,Abhinav,Student@Example.EDU,#`;
    const { rows, errors } = parseRosterCsv(csv);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0].orgDefinedId).toBe("811883567");
    expect(rows[0].email).toBe("student@example.edu");
    expect(rows[0].valid).toBe(true);
  });

  it("trims whitespace and preserves display capitalization", () => {
    const csv = `OrgDefinedId,Last Name,First Name,Email,End-of-Line Indicator\n  #123 ,  Garcia , Amara ,  A@b.edu ,#`;
    const { rows } = parseRosterCsv(csv);
    expect(rows[0].email).toBe("a@b.edu");
    expect(rows[0].lastName).toBe("Garcia");
  });

  it("detects malformed email and malformed ID", () => {
    const csv = `OrgDefinedId,Last Name,First Name,Email,End-of-Line Indicator\nABC,Doe,Jane,not-an-email,#\n,Doe,John,john@example.edu,#`;
    const { rows } = parseRosterCsv(csv);
    expect(rows[0].valid).toBe(false);
    expect(rows[0].errors.join(" ")).toMatch(/OrgDefinedId|email/i);
    expect(rows[1].valid).toBe(false);
  });

  it("rejects missing headers", () => {
    const { errors } = parseRosterCsv(`a,b,c\n1,2,3`);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("reconciles NEW/UNCHANGED/UPDATED/MISSING and flags duplicates", () => {
    const csv = `OrgDefinedId,Last Name,First Name,Email,End-of-Line Indicator\n#1,Last,First,a@example.edu,#\n#1,Last,First,a@example.edu,#\n#2,New,Person,b@example.edu,#`;
    const { rows } = parseRosterCsv(csv);
    const preview = reconcileRoster(rows, [
      { rosterEmail: "a@example.edu", orgDefinedId: "1", firstName: "First", lastName: "Last" },
      { rosterEmail: "gone@example.edu", orgDefinedId: "9", firstName: "G", lastName: "H" },
    ]);
    expect(preview.duplicateCount).toBe(1);
    expect(preview.newCount).toBe(1);
    expect(preview.missingCount).toBe(1);
  });

  it("marks UPDATED when names change", () => {
    const csv = `OrgDefinedId,Last Name,First Name,Email,End-of-Line Indicator\n#1,Changed,First,a@example.edu,#`;
    const { rows } = parseRosterCsv(csv);
    const preview = reconcileRoster(rows, [
      { rosterEmail: "a@example.edu", orgDefinedId: "1", firstName: "First", lastName: "Old" },
    ]);
    expect(preview.updatedCount).toBe(1);
  });
});
