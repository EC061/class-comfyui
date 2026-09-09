"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
export default function AdminHome() {
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
  return (
    <div className="card">
      <h1 className="text-xl font-bold">Admin dashboard</h1>
      <div className="my-4 grid grid-cols-2 gap-3 md:grid-cols-5">
        {Object.entries(labels).map(([k, v]) => (
          <div className="rounded border p-3" key={k}>
            <p className="text-2xl font-bold">{metrics[k] ?? "…"}</p>
            <p>{v}</p>
          </div>
        ))}
      </div>
      <Link href="/admin/classes" className="btn">
        Manage classes
      </Link>
    </div>
  );
}
