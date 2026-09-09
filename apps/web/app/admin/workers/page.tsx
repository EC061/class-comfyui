"use client";
import { useEffect, useState } from "react";

export default function WorkersPage() {
  const [workers, setWorkers] = useState<
    Array<{
      id: string;
      name: string;
      baseUrl: string;
      gpuName: string;
      vramMb: number;
      enabled: boolean;
      healthStatus: string;
      maxConcurrentJobs: number;
      tags: string[];
    }>
  >([]);
  const [form, setForm] = useState({
    name: "a6000-01",
    baseUrl: "http://10.0.0.21:8188",
    gpuName: "RTX A6000",
    vramMb: 49152,
    maxConcurrentJobs: 1,
  });
  const [msg, setMsg] = useState<string | null>(null);

  async function load() {
    const r = await fetch("/api/workers");
    if (r.ok) setWorkers((await r.json()).workers ?? []);
  }
  useEffect(() => {
    load();
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const r = await fetch("/api/workers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    const j = await r.json();
    if (!r.ok) setMsg(j.error);
    else {
      setMsg("Worker registered");
      load();
    }
  }

  async function toggle(w: { id: string; enabled: boolean }) {
    await fetch(`/api/workers/${w.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !w.enabled }),
    });
    load();
  }

  return (
    <div className="grid gap-4">
      <div className="card">
        <h1 className="text-xl font-bold">Workers</h1>
        <p className="text-xs text-slate-500">Worker base URLs are admin-only and never exposed to students.</p>
        <table className="data mt-2">
          <thead>
            <tr>
              <th>Name</th>
              <th>GPU</th>
              <th>VRAM</th>
              <th>Status</th>
              <th>Concurrency</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {workers.map((w) => (
              <tr key={w.id}>
                <td>{w.name}</td>
                <td>{w.gpuName}</td>
                <td>{w.vramMb}</td>
                <td>{w.enabled ? w.healthStatus : "DISABLED"}</td>
                <td>{w.maxConcurrentJobs}</td>
                <td>
                  <button className="btn-secondary" onClick={() => toggle(w)}>
                    {w.enabled ? "Disable" : "Enable"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card">
        <h2 className="font-bold">Register worker</h2>
        <form onSubmit={create} className="mt-2 grid grid-cols-2 gap-2">
          <div>
            <label className="label">name</label>
            <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <label className="label">baseUrl (server-side only)</label>
            <input
              className="input"
              value={form.baseUrl}
              onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
            />
          </div>
          <div>
            <label className="label">gpuName</label>
            <input
              className="input"
              value={form.gpuName}
              onChange={(e) => setForm({ ...form, gpuName: e.target.value })}
            />
          </div>
          <div>
            <label className="label">vramMb</label>
            <input
              className="input"
              type="number"
              value={form.vramMb}
              onChange={(e) => setForm({ ...form, vramMb: Number(e.target.value) })}
            />
          </div>
          <div className="col-span-2">
            <button className="btn" type="submit">
              Register
            </button>
          </div>
        </form>
        {msg && <p className="mt-2 text-sm">{msg}</p>}
      </div>
    </div>
  );
}
