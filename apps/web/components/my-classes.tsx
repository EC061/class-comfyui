"use client";
import { useEffect, useState } from "react";

interface Enrollment {
  classId: string;
  className: string;
  courseCode: string;
  term: string;
  status: string;
  classActive: boolean;
}

/** A student's own classes and the only door into ComfyUI. */
export function MyClasses({ hideWhenEmpty = false }: { hideWhenEmpty?: boolean }) {
  const [enrollments, setEnrollments] = useState<Enrollment[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/auth/session").then(async (r) => {
      const j = r.ok ? await r.json() : {};
      setEnrollments(
        (j.enrollments ?? []).filter((e: Enrollment) => e.status === "ACTIVE" && e.classActive) as Enrollment[]
      );
    });
  }, []);

  async function open(classId: string) {
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

  if (!enrollments) return null;
  if (hideWhenEmpty && !enrollments.length) return null;
  return (
    <div className="card">
      <h2 className="text-xl font-bold">My classes</h2>
      <div className="mt-3 grid gap-2">
        {enrollments.map((e) => (
          <div key={e.classId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3">
            <div>
              <div className="font-medium">
                {e.courseCode} — {e.term}
              </div>
              <div className="text-sm text-slate-600">{e.className}</div>
            </div>
            <button className="btn" onClick={() => open(e.classId)}>
              Open ComfyUI
            </button>
          </div>
        ))}
        {!enrollments.length && (
          <p className="text-sm text-slate-600">
            No active enrollments. Open the signup link your instructor sent to join a class.
          </p>
        )}
      </div>
      {msg && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {msg}
        </p>
      )}
    </div>
  );
}
