"use client";
import Link from "next/link";
import { useEffect, useState } from "react";

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

/** Administrator-only section of the landing page. */
export function AdminOverview() {
  const [metrics, setMetrics] = useState<Record<string, number>>({});
  useEffect(() => {
    const load = () =>
      fetch("/api/admin/metrics").then(async (r) => {
        if (r.ok) setMetrics(await r.json());
      });
    void load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, []);
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
        <Link href="/admin/classes" className="btn">
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
    </div>
  );
}
