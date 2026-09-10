"use client";
import { use, useEffect, useState } from "react";
import { Jobs } from "@/components/jobs";

type Tab = "Overview" | "Roster" | "Signup" | "Jobs" | "Outputs" | "Activity" | "Settings";

export default function ClassDetail({ params: asyncParams }: { params: Promise<{ id: string }> }) {
  const params = use(asyncParams);
  const [tab, setTab] = useState<Tab>("Overview");
  const [cls, setCls] = useState<{
    id: string;
    name: string;
    courseCode: string;
    term: string;
    slug: string;
    active: boolean;
    signupEnabled: boolean;
    description: string;
  } | null>(null);
  const [enrollments, setEnrollments] = useState<
    Array<{
      id: string;
      rosterEmail: string;
      orgDefinedId: string;
      firstName: string;
      lastName: string;
      status: string;
      userId: string | null;
      lastLogin?: string;
      jobs?: number;
      outputs?: number;
      accountStatus?: string;
    }>
  >([]);

  async function load() {
    const r = await fetch(`/api/admin/classes/${params.id}`);
    if (r.ok) {
      const j = await r.json();
      setCls(j.class);
      setEnrollments(j.enrollments ?? []);
    }
  }
  useEffect(() => {
    load();
  }, []);

  if (!cls) return <p>Loading…</p>;
  const tabs: Tab[] = ["Overview", "Roster", "Signup", "Jobs", "Outputs", "Activity", "Settings"];

  return (
    <div className="grid gap-4">
      <h1 className="text-xl font-bold">
        {cls.courseCode} — {cls.term}
      </h1>
      <div className="flex flex-wrap gap-1">
        {tabs.map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`nav-link border ${tab === t ? "nav-link-active" : ""}`}>
            {t}
          </button>
        ))}
      </div>
      {tab === "Overview" && (
        <div className="card text-sm">
          <p>
            <strong>{cls.name}</strong> · {cls.slug} · {cls.active ? "active" : "archived"}
          </p>
          <p className="mt-2">
            Enrolled: {enrollments.length} · Registered: {enrollments.filter((e) => e.userId).length}
          </p>
        </div>
      )}
      {tab === "Roster" && <RosterTab classId={cls.id} enrollments={enrollments} reload={load} />}
      {tab === "Signup" && <SignupTab classId={cls.id} />}
      {tab === "Jobs" && <JobsTab classId={cls.id} />}
      {tab === "Outputs" && <JobsTab classId={cls.id} outputsOnly />}
      {tab === "Activity" && <ActivityTab classId={cls.id} />}
      {tab === "Settings" && <SettingsTab cls={cls} reload={load} />}
    </div>
  );
}

function RosterTab({
  classId,
  enrollments,
  reload,
}: {
  classId: string;
  enrollments: Array<{
    id: string;
    rosterEmail: string;
    orgDefinedId: string;
    firstName: string;
    lastName: string;
    status: string;
    userId: string | null;
    lastLogin?: string;
    jobs?: number;
    outputs?: number;
    accountStatus?: string;
  }>;
  reload: () => void;
}) {
  const [csv, setCsv] = useState("");
  const [importId, setImportId] = useState<string | null>(null);
  const [missing, setMissing] = useState<Array<{ id: string; rosterEmail: string }>>([]);
  const [archiveIds, setArchiveIds] = useState<string[]>([]);
  const [rowPreview, setRowPreview] = useState<any[]>([]);
  const [preview, setPreview] = useState<{
    newCount: number;
    unchangedCount: number;
    updatedCount: number;
    invalidCount: number;
    duplicateCount: number;
    missingCount: number;
    totalRows: number;
  } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);

  // Preview automatically as the CSV changes; the last edit wins.
  useEffect(() => {
    if (!csv.trim()) {
      setPreview(null);
      setImportId(null);
      setMissing([]);
      setRowPreview([]);
      setArchiveIds([]);
      setPreviewing(false);
      return;
    }
    let stale = false;
    setPreviewing(true);
    const timer = setTimeout(async () => {
      try {
        const r = await fetch("/api/roster/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ classId, csv }),
        });
        const j = await r.json();
        if (stale) return;
        if (!r.ok) {
          setMsg(j.error);
          setPreview(null);
          setImportId(null);
          setMissing([]);
          setRowPreview([]);
        } else {
          setPreview(j.preview);
          setImportId(j.importId);
          setMissing(j.preview.missing || []);
          setRowPreview(j.preview.rows || []);
          setArchiveIds([]);
          setMsg(null);
        }
      } catch {
        if (!stale) setMsg("Could not reach the server to preview this roster.");
      } finally {
        if (!stale) setPreviewing(false);
      }
    }, 400);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [classId, csv]);
  async function doImport() {
    const r = await fetch("/api/roster/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ importId, archiveIds }),
    });
    const j = await r.json();
    setMsg(r.ok ? `Imported: ${j.created} new, ${j.updated} updated` : j.error);
    if (r.ok) {
      reload();
      setImportId(null);
    }
  }

  return (
    <div className="grid gap-4">
      <div className="card">
        <h2 className="font-bold">Upload roster</h2>
        <p className="text-xs text-slate-600">
          CSV headers: OrgDefinedId, Last Name, First Name, Email, End-of-Line Indicator
        </p>
        <input
          aria-label="Roster CSV file"
          type="file"
          accept=".csv,text/csv"
          className="my-2"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) {
              if (f.size > 5_000_000) {
                setMsg("CSV exceeds 5 MB");
                return;
              }
              setCsv(await f.text());
              setImportId(null);
            }
          }}
        />
        <textarea
          className="input mt-2 h-32 font-mono"
          value={csv}
          onChange={(e) => {
            setCsv(e.target.value);
            setImportId(null);
          }}
          placeholder="OrgDefinedId,Last Name,First Name,Email,End-of-Line Indicator"
        />
        <div className="mt-2 flex items-center gap-2">
          <button
            className="btn disabled:opacity-50"
            disabled={previewing || !importId || !!preview?.invalidCount || !!preview?.duplicateCount}
            onClick={doImport}
          >
            Confirm import
          </button>
          {previewing && (
            <span role="status" className="text-xs text-slate-600">
              Checking roster…
            </span>
          )}
        </div>
        {preview && (
          <p className="mt-2 text-sm">
            {preview.totalRows} rows · New: {preview.newCount} · Existing: {preview.unchangedCount} · Updated:{" "}
            {preview.updatedCount} · Invalid: {preview.invalidCount} · Duplicates: {preview.duplicateCount} · Missing:{" "}
            {preview.missingCount}
          </p>
        )}
        {rowPreview.length > 0 && (
          <details className="mt-2">
            <summary>Review rows</summary>
            <pre className="max-h-64 overflow-auto text-xs">{JSON.stringify(rowPreview, null, 2)}</pre>
          </details>
        )}
        {missing.length > 0 && (
          <div className="mt-3">
            <p>Missing from this file. Select only enrollments you intend to archive:</p>
            {missing.map((e) => (
              <label key={e.id} className="block">
                <input
                  type="checkbox"
                  checked={archiveIds.includes(e.id)}
                  onChange={(v) =>
                    setArchiveIds(v.target.checked ? [...archiveIds, e.id] : archiveIds.filter((id) => id !== e.id))
                  }
                />{" "}
                {e.rosterEmail}
              </label>
            ))}
          </div>
        )}
        {msg && (
          <p role="status" className="mt-2 text-sm">
            {msg}
          </p>
        )}
        {msg?.startsWith("Imported:") && (
          <p className="mt-2 font-medium">
            Roster imported successfully. Open the Signup tab to generate the student signup link.
          </p>
        )}
      </div>
      <div className="card overflow-x-auto">
        <table className="data">
          <thead>
            <tr>
              <th>Student</th>
              <th>Email</th>
              <th>Student ID</th>
              <th>Account</th>
              <th>Enrollment</th>
              <th>Last login</th>
              <th>Jobs / outputs</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {enrollments.map((e) => (
              <tr key={e.id}>
                <td>
                  {e.firstName} {e.lastName}
                </td>
                <td>{e.rosterEmail}</td>
                <td>{e.orgDefinedId}</td>
                <td>{e.userId ? "registered" : "pending"}</td>
                <td>{e.status}</td>
                <td>{e.lastLogin || "Never"}</td>
                <td>
                  <a className="underline" href={`/admin/jobs?classId=${classId}&userId=${e.userId || "unregistered"}`}>
                    {e.jobs || 0} / {e.outputs || 0}
                  </a>
                </td>
                <td>
                  <button
                    className="btn-secondary"
                    onClick={async () => {
                      const r = await fetch(`/api/admin/classes/${classId}/enrollments`, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ id: e.id, status: e.status === "ARCHIVED" ? "INVITED" : "ARCHIVED" }),
                      });
                      if (!r.ok) setMsg((await r.json()).error);
                      else reload();
                    }}
                  >
                    {e.status === "ARCHIVED" ? "Reactivate" : "Archive"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SignupTab({ classId }: { classId: string }) {
  const [info, setInfo] = useState<{
    signupEnabled: boolean;
    version: number;
    registered: number;
    remaining: number;
    tokenCreatedAt?: string;
  } | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function load() {
    const r = await fetch(`/api/admin/classes/${classId}/signup`);
    if (r.ok) setInfo(await r.json());
  }
  useEffect(() => {
    load();
  }, []);

  async function regen() {
    const r = await fetch(`/api/admin/classes/${classId}/signup`, { method: "POST" });
    const j = await r.json();
    if (r.ok) {
      setUrl(j.url);
      load();
    } else setMsg(j.error);
  }
  async function toggle(enabled: boolean) {
    const r = await fetch(`/api/admin/classes/${classId}/signup`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    if (r.ok) load();
  }
  async function emailStudents() {
    if (!url) {
      setMsg("Generate/regenerate the URL first (plain token is only shown once), then email.");
      return;
    }
    const r = await fetch(`/api/admin/classes/${classId}/email-signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signupUrl: url }),
    });
    const j = await r.json();
    setMsg(r.ok ? `Emailed ${j.sent} students; ${j.failed || 0} failed` : j.error);
  }

  return (
    <div className="card">
      <h2 className="font-bold">Student signup</h2>
      <p className="text-sm">Status: {info?.signupEnabled ? "Enabled" : "Disabled"}</p>
      {url ? (
        <div className="mt-2">
          <p className="text-sm font-medium">Signup URL:</p>
          <p className="break-all rounded bg-slate-100 p-2 font-mono text-xs">{url}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button className="btn-secondary" onClick={() => navigator.clipboard.writeText(url)}>
              Copy URL
            </button>
            <button className="btn-secondary" onClick={emailStudents}>
              Email unregistered students
            </button>
            <button className="btn-secondary" onClick={regen}>
              Regenerate URL
            </button>
            <button className="btn-secondary" onClick={() => toggle(false)}>
              Disable signup
            </button>
            <button className="btn-secondary" onClick={() => toggle(true)}>
              Enable signup
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex gap-2">
          <button className="btn-secondary" onClick={() => toggle(false)}>
            Disable signup
          </button>
          <button className="btn" onClick={regen}>
            Generate student signup link
          </button>
          <button className="btn-secondary" onClick={() => toggle(true)}>
            Enable signup
          </button>
        </div>
      )}
      {info && (
        <p className="mt-2 text-sm">
          Created / regenerated: {info.tokenCreatedAt || "Not generated"} · Registered: {info.registered} · Remaining:{" "}
          {info.remaining} · Version: {info.version}
        </p>
      )}
      {msg && <p className="mt-2 text-sm">{msg}</p>}
      <p className="mt-2 text-xs text-slate-500">
        Possessing the link alone never creates an account — the email must match the roster and be verified by SMTP.
      </p>
    </div>
  );
}

function JobsTab({ classId, outputsOnly }: { classId: string; outputsOnly?: boolean }) {
  return <Jobs classId={classId} outputsOnly={outputsOnly} />;
}

function ActivityTab({ classId }: { classId: string }) {
  const [events, setEvents] = useState<Array<{ id: string; type: string; createdAt: string }>>([]);
  useEffect(() => {
    fetch(`/api/audit?classId=${classId}`).then(async (r) => {
      if (r.ok) setEvents((await r.json()).events ?? []);
    });
  }, [classId]);
  return (
    <div className="card">
      <h2 className="font-bold">Activity</h2>
      <ul className="mt-2 text-sm">
        {events.map((e) => (
          <li key={e.id} className="border-b py-1">
            {e.type} · {e.createdAt}
          </li>
        ))}
      </ul>
    </div>
  );
}

function SettingsTab({
  cls,
  reload,
}: {
  cls: { id: string; name: string; active: boolean; courseCode?: string; term?: string; description?: string };
  reload: () => void;
}) {
  const [name, setName] = useState(cls.name),
    [courseCode, setCourseCode] = useState(cls.courseCode || ""),
    [term, setTerm] = useState(cls.term || ""),
    [description, setDescription] = useState(cls.description || ""),
    [message, setMessage] = useState("");
  async function save(e: React.FormEvent) {
    e.preventDefault();
    const r = await fetch("/api/admin/classes/" + cls.id, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, ...(courseCode ? { courseCode } : {}), ...(term ? { term } : {}), description }),
    });
    setMessage(r.ok ? "Class updated" : (await r.json()).error);
    reload();
  }
  async function toggle() {
    const r = await fetch("/api/admin/classes/" + cls.id, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !cls.active }),
    });
    if (!r.ok) setMessage((await r.json()).error);
    reload();
  }
  return (
    <div className="card">
      <h2 className="font-bold">Class settings</h2>
      <form onSubmit={save} className="my-3 grid gap-2">
        <label>
          Name
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Course code
          <input
            className="input"
            placeholder="Leave blank to keep current value"
            value={courseCode}
            onChange={(e) => setCourseCode(e.target.value)}
          />
        </label>
        <label>
          Term
          <input
            className="input"
            placeholder="Leave blank to keep current value"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
          />
        </label>
        <label>
          Description
          <textarea className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <button className="btn">Save class</button>
      </form>
      <button className="btn-secondary" onClick={toggle}>
        {cls.active ? "Archive class" : "Reactivate class"}
      </button>
      <p role="status">{message}</p>
    </div>
  );
}
