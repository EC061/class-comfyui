export type RosterRowState = "NEW" | "UNCHANGED" | "UPDATED" | "MISSING_FROM_NEW_ROSTER" | "INVALID" | "DUPLICATE";

export interface ParsedRosterRow {
  line: number;
  orgDefinedId: string; // without leading #
  lastName: string;
  firstName: string;
  email: string; // canonical lowercase
  displayEmail: string;
  raw: Record<string, string>;
  valid: boolean;
  errors: string[];
}

export interface RosterPreview {
  totalRows: number;
  newCount: number;
  unchangedCount: number;
  updatedCount: number;
  invalidCount: number;
  duplicateCount: number;
  missingCount: number;
  rows: Array<ParsedRosterRow & { state: RosterRowState }>;
  errors: string[];
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function splitCsvLine(line: string): string[] {
  // Minimal CSV parser supporting quoted fields with commas and escaped quotes.
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") {
        out.push(cur);
        cur = "";
      } else cur += c;
    }
  }
  out.push(cur);
  return out;
}

export function parseRosterCsv(csvText: string): { rows: ParsedRosterRow[]; errors: string[] } {
  const errors: string[] = [];
  const lines = csvText.split(/\r?\n/);
  // Remove BOM
  if (lines.length > 0 && lines[0].charCodeAt(0) === 0xfeff) lines[0] = lines[0].slice(1);
  // Drop trailing empty lines
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  if (lines.length === 0) return { rows: [], errors: ["Empty file"] };

  const headerCells = splitCsvLine(lines[0]).map((h) => h.trim());
  const expected = ["OrgDefinedId", "Last Name", "First Name", "Email", "End-of-Line Indicator"];
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const headerNorm = headerCells.map(norm);
  const expectedNorm = expected.map(norm);
  const hasAll = expectedNorm.every((e) => headerNorm.includes(e));
  if (!hasAll) {
    return {
      rows: [],
      errors: [`Missing required headers. Expected: ${expected.join(", ")}. Got: ${headerCells.join(", ")}`],
    };
  }
  const idx: Record<string, number> = {};
  for (const e of expected) {
    idx[e] = headerNorm.indexOf(norm(e));
  }

  const rows: ParsedRosterRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const lineNo = i + 1;
    if (lines[i].trim() === "") continue;
    const cells = splitCsvLine(lines[i]);
    const get = (name: string) => (cells[idx[name]] ?? "").trim();
    const rawId = get("OrgDefinedId");
    const lastName = get("Last Name");
    const firstName = get("First Name");
    const emailRaw = get("Email");
    const email = emailRaw.trim().toLowerCase();
    const rowErrors: string[] = [];

    let orgId = rawId.trim();
    if (orgId.startsWith("#")) orgId = orgId.slice(1);
    orgId = orgId.trim();
    if (!orgId) rowErrors.push("Missing OrgDefinedId");
    else if (!/^[0-9]+$/.test(orgId)) rowErrors.push(`Malformed OrgDefinedId: ${rawId}`);

    if (!emailRaw) rowErrors.push("Missing email");
    else if (!EMAIL_RE.test(email)) rowErrors.push(`Malformed email: ${emailRaw}`);
    else if (email.length > 320) rowErrors.push("Email too long");

    if (!firstName) rowErrors.push("Missing first name");
    if (!lastName) rowErrors.push("Missing last name");

    rows.push({
      line: lineNo,
      orgDefinedId: orgId,
      lastName,
      firstName,
      email,
      displayEmail: emailRaw.trim(),
      raw: {
        OrgDefinedId: rawId,
        "Last Name": lastName,
        "First Name": firstName,
        Email: emailRaw,
      },
      valid: rowErrors.length === 0,
      errors: rowErrors,
    });
  }
  return { rows, errors };
}

export interface ExistingEnrollmentLite {
  rosterEmail: string; // canonical
  orgDefinedId: string;
  firstName: string;
  lastName: string;
}

/** Reconcile parsed rows against existing enrollments. Pure function for preview + tests. */
export function reconcileRoster(parsed: ParsedRosterRow[], existing: ExistingEnrollmentLite[]): RosterPreview {
  const byEmail = new Map(existing.map((e) => [e.rosterEmail.toLowerCase(), e]));
  const byId = new Map(existing.map((e) => [e.orgDefinedId, e]));
  const seenEmail = new Set<string>();
  const seenId = new Set<string>();

  const rows: RosterPreview["rows"] = [];
  let newCount = 0,
    unchangedCount = 0,
    updatedCount = 0,
    invalidCount = 0,
    duplicateCount = 0;

  for (const r of parsed) {
    if (!r.valid) {
      invalidCount++;
      rows.push({ ...r, state: "INVALID" });
      continue;
    }
    const emailDup = seenEmail.has(r.email);
    const idDup = seenId.has(r.orgDefinedId);
    if (emailDup || idDup) {
      duplicateCount++;
      rows.push({
        ...r,
        state: "DUPLICATE",
        valid: false,
        errors: [...r.errors, emailDup ? "Duplicate email in file" : "Duplicate student ID in file"],
      });
      continue;
    }
    seenEmail.add(r.email);
    seenId.add(r.orgDefinedId);

    const exByEmail = byEmail.get(r.email);
    const exById = byId.get(r.orgDefinedId);
    const ex = exByEmail ?? (exById && exById.rosterEmail !== r.email ? undefined : exById);
    // If email exists but ID differs, or ID exists but email differs -> treat as UPDATED with note
    if (!exByEmail && !exById) {
      newCount++;
      rows.push({ ...r, state: "NEW" });
    } else {
      const match = exByEmail ?? exById!;
      const same =
        match.firstName === r.firstName &&
        match.lastName === r.lastName &&
        match.orgDefinedId === r.orgDefinedId &&
        match.rosterEmail.toLowerCase() === r.email;
      if (same) {
        unchangedCount++;
        rows.push({ ...r, state: "UNCHANGED" });
      } else {
        updatedCount++;
        rows.push({ ...r, state: "UPDATED" });
      }
    }
  }

  const newEmails = new Set(parsed.filter((r) => r.valid).map((r) => r.email));
  const newIds = new Set(parsed.filter((r) => r.valid).map((r) => r.orgDefinedId));
  let missingCount = 0;
  for (const e of existing) {
    if (!newEmails.has(e.rosterEmail.toLowerCase()) && !newIds.has(e.orgDefinedId)) {
      missingCount++;
      rows.push({
        line: -1,
        orgDefinedId: e.orgDefinedId,
        lastName: e.lastName,
        firstName: e.firstName,
        email: e.rosterEmail,
        displayEmail: e.rosterEmail,
        raw: {},
        valid: true,
        errors: [],
        state: "MISSING_FROM_NEW_ROSTER",
      });
    }
  }

  return {
    totalRows: parsed.length,
    newCount,
    unchangedCount,
    updatedCount,
    invalidCount,
    duplicateCount,
    missingCount,
    rows,
    errors: [],
  };
}
