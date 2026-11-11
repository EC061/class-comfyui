"use client";
import { useEffect, useState } from "react";

interface Enrollment {
  classId: string;
  className: string;
  courseCode: string;
  term: string;
  status: string;
  classActive: boolean;
  classPaused?: boolean;
}

/** A student's own classes and the only door into ComfyUI. */
export function MyClasses({ hideWhenEmpty = false }: { hideWhenEmpty?: boolean }) {
  const [enrollments, setEnrollments] = useState<Enrollment[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [pausedModal, setPausedModal] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      fetch("/api/auth/session").then(async (r) => {
        const j = r.ok ? await r.json() : {};
        setEnrollments(
          (j.enrollments ?? []).filter((e: Enrollment) => e.status === "ACTIVE" && e.classActive) as Enrollment[]
        );
      });
    void load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, []);

  async function open(e: Enrollment) {
    setMsg(null);
    if (e.classPaused) {
      const text = `Access to ComfyUI for ${e.courseCode} — ${e.term} is currently paused by your instructor. You can still view your past jobs and outputs below.`;
      setPausedModal(text);
      setMsg(text);
      return;
    }
    const r = await fetch("/api/workspace/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ classId: e.classId }),
    });
    const j = await r.json();
    if (!r.ok) {
      const errText = j.error ?? "Could not open ComfyUI";
      setMsg(errText);
      if (j.code === "CLASS_PAUSED") {
        setPausedModal(errText);
        setEnrollments((prev) =>
          prev ? prev.map((item) => (item.classId === e.classId ? { ...item, classPaused: true } : item)) : prev
        );
      }
    } else {
      window.location.href = j.url;
    }
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
              <div className="flex items-center gap-2 font-medium">
                <span>
                  {e.courseCode} — {e.term}
                </span>
                {e.classPaused && (
                  <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
                    Access paused
                  </span>
                )}
              </div>
              <div className="text-sm text-slate-600">{e.className}</div>
              {e.classPaused && (
                <div className="mt-1 text-xs font-medium text-amber-800">
                  Access to ComfyUI is currently paused by your instructor. Your past jobs and outputs remain available
                  below.
                </div>
              )}
            </div>
            <button
              className={e.classPaused ? "btn-secondary border-amber-300 text-amber-900" : "btn"}
              onClick={() => open(e)}
            >
              {e.classPaused ? "Access paused" : "Open ComfyUI"}
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
      {pausedModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="paused-access-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
        >
          <div className="max-w-md rounded-lg bg-white p-6 shadow-xl">
            <h3 id="paused-access-title" className="text-lg font-bold text-amber-900">
              Class access is paused
            </h3>
            <p className="mt-2 text-sm text-slate-700">{pausedModal}</p>
            <div className="mt-4 flex justify-end">
              <button className="btn" onClick={() => setPausedModal(null)}>
                OK
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
