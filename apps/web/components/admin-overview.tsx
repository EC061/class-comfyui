"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { OpenComfyButton } from "./open-comfy-button";

const labels: Record<string, string> = {
  activeClasses: "Active classes",
  students: "Registered students",
  pending: "Pending registrations",
  queued: "Queued jobs",
  active: "Active jobs",
  workers: "Workers",
  gpus: "Online GPUs",
  jobsToday: "Jobs today",
  failures: "Failed or lost jobs",
  outputsToday: "Outputs today",
};

interface AdminClassSummary {
  id: string;
  name: string;
  courseCode: string;
  term: string;
  slug: string;
  active: boolean;
  paused?: boolean;
  h3Video?: boolean;
  enrolled?: number;
  registered?: number;
}

/** Administrator-only section of the landing page. */
export function AdminOverview() {
  const [metrics, setMetrics] = useState<Record<string, number>>({});
  const [classes, setClasses] = useState<AdminClassSummary[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadClasses() {
    const r = await fetch("/api/admin/classes");
    if (r.ok) {
      const j = await r.json();
      setClasses(((j.classes ?? []) as AdminClassSummary[]).filter((c) => c.active));
    }
  }

  useEffect(() => {
    const load = () => {
      void fetch("/api/admin/metrics").then(async (r) => {
        if (r.ok) setMetrics(await r.json());
      });
      void loadClasses();
    };
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  async function toggleAccess(c: AdminClassSummary) {
    setBusyId(c.id);
    setError(null);
    try {
      const r = await fetch(`/api/admin/classes/${c.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paused: !c.paused }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setError(j.error ?? "Could not update class access");
      }
      await loadClasses();
    } catch {
      setError("Could not reach server to update class access");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="card">
      <h2 className="text-xl font-bold">Lab status</h2>
      <div className="my-4 grid grid-cols-2 gap-3 md:grid-cols-5">
        {Object.entries(labels).map(([k, v]) => (
          <div className="rounded border p-3" key={k}>
            <p className="text-2xl font-bold">{metrics[k] ?? "…"}</p>
            <p className="text-sm">{v}</p>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <OpenComfyButton className="btn" />
        <Link href="/admin/classes" className="btn-secondary">
          Manage classes
        </Link>
        <Link href="/admin/workers" className="btn-secondary">
          Workers
        </Link>
        <Link href="/admin/students" className="btn-secondary">
          Students
        </Link>
        <Link href="/admin/settings" className="btn-secondary">
          Settings
        </Link>
      </div>
      {classes.length > 0 && (
        <div className="mt-5 border-t pt-4">
          <h3 className="text-sm font-semibold text-slate-700">Class access controls</h3>
          {error && (
            <p role="alert" className="mt-1 text-xs text-red-600">
              {error}
            </p>
          )}
          <div className="mt-2 grid gap-2">
            {classes.map((c) => (
              <div key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/admin/classes/${c.id}`} className="font-medium underline">
                      {c.courseCode} — {c.term}
                    </Link>
                    <span
                      className={`rounded px-2 py-0.5 text-xs font-semibold ${
                        c.paused ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-800"
                      }`}
                    >
                      {c.paused ? "Access disabled" : "Access enabled"}
                    </span>
                    {c.h3Video && (
                      <span className="rounded bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-800">
                        H3 enabled for all
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-600">
                    {c.name} · {c.registered ?? 0}/{c.enrolled ?? 0} registered
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={busyId === c.id}
                    className={
                      c.paused
                        ? "btn py-1.5 text-xs"
                        : "btn-secondary border-amber-300 py-1.5 text-xs text-amber-900 hover:bg-amber-50"
                    }
                    onClick={() => toggleAccess(c)}
                  >
                    {c.paused ? "Enable class access" : "Disable class access"}
                  </button>
                  <Link href={`/admin/classes/${c.id}`} className="btn-secondary py-1.5 text-xs">
                    Open class
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
