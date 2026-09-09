"use client";
import { useEffect, useState } from "react";

interface Session {
  user: { id: string; email: string; globalRole: string } | null;
  enrollments?: Array<{
    classId: string;
    classSlug: string;
    className: string;
    courseCode: string;
    term: string;
    status: string;
  }>;
}

export default function DashboardPage() {
  const [sess, setSess] = useState<Session | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/auth/session").then(async (r) => setSess(await r.json()));
  }, []);

  async function openComfy(classId: string) {
    setMsg(null);
    const r = await fetch("/api/workspace/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ classId }),
    });
    const j = await r.json();
    if (!r.ok) setMsg(j.error ?? "Could not open ComfyUI");
    else window.location.href = j.url;
  }

  if (!sess) return <p>Loading…</p>;
  if (!sess.user)
    return (
      <p>
        Not signed in.{" "}
        <a className="underline" href="/login">
          Log in
        </a>
      </p>
    );

  return (
    <div className="grid gap-4">
      <div className="card">
        <h1 className="text-xl font-bold">My classes</h1>
        <p className="text-sm text-slate-600">{sess.user.email}</p>
        <div className="mt-4 grid gap-2">
          {(sess.enrollments ?? []).map((e) => (
            <div key={e.classId} className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <div className="font-medium">
                  {e.courseCode} — {e.term}
                </div>
                <div className="text-sm text-slate-600">
                  {e.className} · {e.status}
                </div>
              </div>
              <button className="btn" onClick={() => openComfy(e.classId)}>
                Open ComfyUI
              </button>
            </div>
          ))}
          {(sess.enrollments ?? []).length === 0 && <p className="text-sm">No enrollments yet.</p>}
        </div>
        {msg && <p className="mt-2 text-sm text-red-600">{msg}</p>}
      </div>
      <MyJobs />
    </div>
  );
}

function MyJobs() {
  const [jobs, setJobs] = useState<
    Array<{ id: string; status: string; submittedAt: string; workerName: string | null }>
  >([]);
  useEffect(() => {
    fetch("/api/jobs").then(async (r) => {
      if (r.ok) setJobs((await r.json()).jobs ?? []);
    });
  }, []);
  return (
    <div className="card">
      <h2 className="font-bold">My jobs</h2>
      <table className="data mt-2">
        <thead>
          <tr>
            <th>ID</th>
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
