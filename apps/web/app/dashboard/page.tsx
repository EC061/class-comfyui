"use client";
import { useEffect, useState } from "react";
import { Jobs } from "@/components/jobs";

interface Session {
  user: { id: string; email: string; globalRole: string } | null;
  enrollments?: Array<{
    classId: string;
    classSlug: string;
    className: string;
    courseCode: string;
    term: string;
    status: string;
    classActive: boolean;
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
          {(sess.enrollments ?? [])
            .filter((e) => e.status === "ACTIVE" && e.classActive)
            .map((e) => (
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
  return <Jobs />;
}
