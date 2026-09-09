"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
export function Jobs({
  classId = "",
  userId = "",
  outputsOnly = false,
}: {
  classId?: string;
  userId?: string;
  outputsOnly?: boolean;
}) {
  const [jobs, setJobs] = useState<any[]>([]),
    [q, setQ] = useState(""),
    [status, setStatus] = useState(""),
    [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [worker, setWorker] = useState(""),
    [type, setType] = useState(""),
    [message, setMessage] = useState("");
  useEffect(() => {
    const load = async () => {
      const r = await fetch(
        "/api/jobs?" + new URLSearchParams({ classId, userId, q, status, from, to, workerId: worker, outputType: type })
      );
      if (r.ok) setJobs((await r.json()).jobs);
      else setMessage("Unable to load jobs");
    };
    void load();
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [classId, userId, q, status, from, to, worker, type]);
  return (
    <div className="card">
      <h2 className="text-xl font-bold">{outputsOnly ? "Outputs" : "Jobs"}</h2>
      <div className="my-3 grid gap-2 md:grid-cols-3">
        <input
          aria-label="Search jobs"
          className="input"
          placeholder="Student email, ID, or job ID"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select aria-label="Job status" className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {["QUEUED", "DISPATCHING", "RUNNING", "COMPLETED", "FAILED", "CANCELLED", "LOST"].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <select aria-label="Output type" className="input" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">All output types</option>
          {["image/", "video/", "audio/"].map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
        <label>
          From
          <input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          To
          <input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <input
          aria-label="Worker ID"
          className="input"
          placeholder="Worker UUID (optional)"
          value={worker}
          onChange={(e) => setWorker(e.target.value)}
        />
      </div>
      {message && <p role="alert">{message}</p>}
      <div className="overflow-x-auto">
        <table className="data">
          <thead>
            <tr>
              <th>Job</th>
              <th>Student</th>
              <th>Status / archive</th>
              <th>Worker</th>
              <th>Outputs</th>
            </tr>
          </thead>
          <tbody>
            {jobs
              .filter((j) => !outputsOnly || j.outputs.length)
              .map((j) => (
                <tr key={j.id}>
                  <td>
                    <Link className="underline" href={"/jobs/" + j.id}>
                      {j.id.slice(0, 8)}
                    </Link>
                    <p className="text-xs">{j.submittedAt}</p>
                  </td>
                  <td>
                    {j.email}
                    <p>{j.orgDefinedId}</p>
                  </td>
                  <td>
                    {j.status}
                    <p className="text-xs">{j.archiveStatus}</p>
                  </td>
                  <td>{j.workerName || "Waiting"}</td>
                  <td>
                    {j.outputs.map((o: any) => (
                      <a key={o.id} className="block underline" href={o.url}>
                        {o.originalFilename} ({Math.ceil(o.sizeBytes / 1024)} KB)
                      </a>
                    ))}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      {!jobs.length && <p className="py-3">No jobs yet.</p>}
    </div>
  );
}
