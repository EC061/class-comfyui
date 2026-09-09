"use client";
import { useEffect, useState } from "react";

export default function AuditPage() {
  const [events, setEvents] = useState<
    Array<{
      id: string;
      type: string;
      classId: string | null;
      targetId: string;
      createdAt: string;
      metadata: Record<string, unknown>;
    }>
  >([]);
  const [type, setType] = useState("");
  const [q, setQ] = useState("");
  async function load() {
    const r = await fetch(`/api/audit?type=${encodeURIComponent(type)}&q=${encodeURIComponent(q)}`);
    if (r.ok) setEvents((await r.json()).events ?? []);
  }
  useEffect(() => {
    load();
  }, []);
  return (
    <div className="card">
      <h1 className="text-xl font-bold">Audit</h1>
      <div className="mt-2 flex gap-2">
        <input className="input" placeholder="Type filter…" value={type} onChange={(e) => setType(e.target.value)} />
        <input className="input" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn-secondary" onClick={load}>
          Filter
        </button>
      </div>
      <table className="data mt-3">
        <thead>
          <tr>
            <th>Type</th>
            <th>Class</th>
            <th>Target</th>
            <th>Time</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.id}>
              <td>{e.type}</td>
              <td className="font-mono text-xs">
                {e.classId ? (
                  <a className="underline" href={`/admin/classes/${e.classId}`}>
                    {e.classId.slice(0, 8)}
                  </a>
                ) : (
                  "—"
                )}
              </td>
              <td className="font-mono text-xs">
                {e.type.startsWith("JOB_") ? (
                  <a className="underline" href={`/jobs/${e.targetId}`}>
                    {e.targetId.slice(0, 8)}
                  </a>
                ) : (
                  e.targetId.slice(0, 8)
                )}
              </td>
              <td>{e.createdAt}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
