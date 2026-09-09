"use client";
import Link from "next/link";
import { useEffect, useState } from "react";

export default function AdminHome() {
  const [data, setData] = useState<{
    classes?: Array<{ id: string; slug: string; active: boolean; enrolled: number; registered: number }>;
    workers?: Array<{ healthStatus: string; enabled: boolean; name: string }>;
  } | null>(null);

  useEffect(() => {
    (async () => {
      const [c, w] = await Promise.all([fetch("/api/admin/classes"), fetch("/api/workers")]);
      setData({
        classes: c.ok ? (await c.json()).classes : [],
        workers: w.ok ? (await w.json()).workers : [],
      });
    })();
  }, []);

  return (
    <div className="grid gap-4">
      <nav className="flex flex-wrap gap-1">
        {[
          ["/admin", "Dashboard"],
          ["/admin/classes", "Classes"],
          ["/admin/students", "Students"],
          ["/admin/jobs", "Jobs"],
          ["/admin/workers", "Workers"],
          ["/admin/audit", "Audit"],
          ["/admin/settings", "Settings"],
        ].map(([href, label]) => (
          <Link key={href} className="nav-link border" href={href}>
            {label}
          </Link>
        ))}
      </nav>
      <div className="card">
        <h1 className="text-xl font-bold">Admin dashboard</h1>
        <div className="mt-3 grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
          <Stat label="Active classes" value={data?.classes?.filter((c) => c.active).length ?? "…"} />
          <Stat
            label="Registered students"
            value={data?.classes?.reduce((n, c) => n + (c.registered ?? 0), 0) ?? "…"}
          />
          <Stat
            label="Pending registrations"
            value={data?.classes?.reduce((n, c) => n + Math.max(0, (c.enrolled ?? 0) - (c.registered ?? 0)), 0) ?? "…"}
          />
          <Stat label="Workers" value={data?.workers?.length ?? "…"} />
        </div>
        <div className="mt-4">
          <Link className="btn" href="/admin/classes">
            Manage classes
          </Link>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-slate-600">{label}</div>
    </div>
  );
}
