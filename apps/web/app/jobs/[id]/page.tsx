"use client";
import { use, useEffect, useState } from "react";
export default function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params),
    [job, setJob] = useState<any>(null),
    [error, setError] = useState("");
  useEffect(() => {
    const load = async () => {
      const r = await fetch("/api/jobs/" + id),
        j = await r.json();
      if (r.ok) setJob(j.job);
      else setError(j.error);
    };
    void load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [id]);
  async function cancel() {
    const r = await fetch("/api/jobs/" + id, { method: "DELETE" });
    if (!r.ok) setError((await r.json()).error);
  }
  async function retry() {
    const r = await fetch("/api/jobs/" + id + "/archive", { method: "POST" });
    setError(r.ok ? "Archival retry requested" : (await r.json()).error);
  }
  if (error && !job) return <p role="alert">{error}</p>;
  if (!job) return <p>Loading job…</p>;
  return (
    <div className="grid gap-4">
      <h1 className="text-xl font-bold">Job {job.id}</h1>
      <div className="card">
        <p>
          {job.email} · Student ID {job.orgDefinedId}
        </p>
        <p>
          {job.status} · Archive: {job.archiveStatus} · Worker: {job.workerName || "Unassigned"}
        </p>
        <p>
          Submitted {job.submittedAt} · Runtime {job.runtimeMs === null ? "pending" : job.runtimeMs / 1000 + "s"}
        </p>
        {job.error && <p role="alert">{job.error}</p>}
        {job.archiveError && <p role="alert">{job.archiveError}</p>}
        {["QUEUED", "DISPATCHING", "RUNNING"].includes(job.status) && (
          <button className="btn-secondary mt-2" onClick={cancel}>
            Cancel my job
          </button>
        )}
        {job.archiveStatus === "FAILED" && (
          <button className="btn-secondary" onClick={retry}>
            Retry archival
          </button>
        )}
        {error && <p>{error}</p>}
      </div>
      <div className="card">
        <h2 className="font-bold">Outputs</h2>
        {job.outputs.map((o: any) => (
          <div key={o.id} className="border-b py-2">
            <a className="underline" href={o.url}>
              {o.originalFilename}
            </a>
            <p className="text-sm">
              {o.mimeType} · {o.sizeBytes} bytes
            </p>
            <p className="break-all font-mono text-xs">SHA-256: {o.sha256}</p>
          </div>
        ))}
      </div>
      <details className="card">
        <summary>API prompt</summary>
        <pre className="overflow-auto text-xs">
          {JSON.stringify(job.submittedPromptJson || job.promptJson, null, 2)}
        </pre>
      </details>
      <details className="card">
        <summary>Workflow</summary>
        <pre className="overflow-auto text-xs">{JSON.stringify(job.workflowJson, null, 2)}</pre>
      </details>
    </div>
  );
}
