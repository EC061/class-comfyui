"use client";
import { useEffect, useState } from "react";

export default function JobsPage() {
  const [jobs, setJobs] = useState<
    Array<{ id: string; status: string; submittedAt: string; workerName: string | null; classId: string }>
  >([]);
  useEffect(() => {
    fetch("/api/jobs").then(async (r) => {
      if (r.ok) setJobs((await r.json()).jobs ?? []);
    });
  }, []);
  return (
    <div className="card">
      <h1 className="text-xl font-bold">Jobs</h1>
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
