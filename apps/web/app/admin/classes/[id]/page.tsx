"use client";
import { useEffect, useState } from "react";

type Tab = "Overview" | "Roster" | "Signup" | "Jobs" | "Outputs" | "Activity" | "Settings";

export default function ClassDetail({ params }: { params: { id: string } }) {
  const [tab, setTab] = useState<Tab>("Overview");
  const [cls, setCls] = useState<{
    id: string;
    name: string;
    courseCode: string;
    term: string;
    slug: string;
    active: boolean;
    signupEnabled: boolean;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  }>;
  reload: () => void;
}) {
  const [csv, setCsv] = useState("");
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

  async function doPreview() {
    const r = await fetch("/api/roster/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ classId, csv }),
    });
    const j = await r.json();
    if (!r.ok) setMsg(j.error);
    else {
      setPreview(j.preview);
      setMsg(null);
    }
  }
  async function doImport() {
    const r = await fetch("/api/roster/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ classId, csv }),
    });
    const j = await r.json();
    setMsg(r.ok ? `Imported: ${j.created} new, ${j.updated} updated` : j.error);
    if (r.ok) reload();
  }

  return (
    <div className="grid gap-4">
      <div className="card">
        <h2 className="font-bold">Upload roster</h2>
        <p className="text-xs text-slate-600">
          CSV headers: OrgDefinedId, Last Name, First Name, Email, End-of-Line Indicator
        </p>
        <textarea
          className="input mt-2 h-32 font-mono"
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
          placeholder="OrgDefinedId,Last Name,First Name,Email,End-of-Line Indicator"
        />
        <div className="mt-2 flex gap-2">
          <button className="btn-secondary" onClick={doPreview}>
            Preview
          </button>
          <button className="btn" onClick={doImport}>
            Confirm import
          </button>
        </div>
        {preview && (
          <p className="mt-2 text-sm">
            {preview.totalRows} rows · New: {preview.newCount} · Existing: {preview.unchangedCount} · Updated:{" "}
            {preview.updatedCount} · Invalid: {preview.invalidCount} · Duplicates: {preview.duplicateCount} · Missing:{" "}
            {preview.missingCount}
          </p>
        )}
        {msg && <p className="mt-2 text-sm">{msg}</p>}
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
  } | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function load() {
    const r = await fetch(`/api/admin/classes/${classId}/signup`);
    if (r.ok) setInfo(await r.json());
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    setMsg(r.ok ? `Emailed ${j.sent} unregistered students` : j.error);
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
          Registered: {info.registered} · Remaining: {info.remaining} · Version: {info.version}
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
  const [jobs, setJobs] = useState<
    Array<{
      id: string;
      status: string;
      submittedAt: string;
      workerName: string | null;
      outputs?: Array<{ fileName: string }>;
    }>
  >([]);
  useEffect(() => {
    fetch(`/api/jobs?classId=${classId}`).then(async (r) => {
      if (r.ok) setJobs((await r.json()).jobs ?? []);
    });
  }, [classId]);
  return (
    <div className="card">
      <h2 className="font-bold">{outputsOnly ? "Outputs" : "Jobs"}</h2>
      <table className="data mt-2">
        <thead>
          <tr>
            <th>Job</th>
            <th>Status</th>
            <th>Worker</th>
            <th>Submitted</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => (
            <tr key={j.id}>
              <td className="font-mono text-xs">{j.id.slice(0, 8)}</td>
              <td>{j.status}</td>
              <td>{j.workerName ?? "—"}</td>
              <td>{j.submittedAt}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
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

function SettingsTab({ cls, reload }: { cls: { id: string; name: string; active: boolean }; reload: () => void }) {
  async function setActive(active: boolean) {
    await fetch(`/api/admin/classes/${cls.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active }),
    });
    reload();
  }
  return (
    <div className="card">
      <h2 className="font-bold">Settings</h2>
      <div className="mt-2 flex gap-2">
        <button className="btn-secondary" onClick={() => setActive(!cls.active)}>
          {cls.active ? "Archive class" : "Reactivate class"}
        </button>
      </div>
    </div>
  );
}
