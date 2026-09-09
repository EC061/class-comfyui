"use client";
import { useEffect, useState } from "react";
const initial = {
  name: "a6000-01",
  baseUrl: "http://10.0.0.21:8188",
  gpuName: "RTX A6000",
  vramMb: 49152,
  maxConcurrentJobs: 1,
  architecture: "amd64",
  tags: "a6000,48gb",
};
export default function Workers() {
  const [workers, setWorkers] = useState<any[]>([]),
    [form, setForm] = useState(initial),
    [editing, setEditing] = useState<string | null>(null),
    [msg, setMsg] = useState("");
  async function load() {
    const r = await fetch("/api/workers");
    if (r.ok) setWorkers((await r.json()).workers);
  }
  useEffect(() => {
    void load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, []);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    const r = await fetch("/api/workers" + (editing ? "/" + editing : ""), {
      method: editing ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...form,
        tags: form.tags
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean),
      }),
    });
    const j = await r.json();
    setMsg(r.ok ? (editing ? "Worker updated" : "Worker registered") : j.error);
    if (r.ok) {
      setEditing(null);
      void load();
    }
  }
  async function toggle(w: any) {
    const r = await fetch("/api/workers/" + w.id, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !w.enabled }),
    });
    if (!r.ok) setMsg((await r.json()).error);
    void load();
  }
  return (
    <div className="grid gap-4">
      <div className="card">
        <h1 className="text-xl font-bold">Workers</h1>
        <div className="overflow-x-auto">
          <table className="data">
            <thead>
              <tr>
                <th>Name / ID</th>
                <th>GPU / tags</th>
                <th>VRAM</th>
                <th>Health</th>
                <th>Capacity</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {workers.map((w) => (
                <tr key={w.id}>
                  <td>
                    {w.name}
                    <p className="font-mono text-xs">{w.id}</p>
                  </td>
                  <td>
                    {w.gpuName}
                    <p>{w.tags.join(", ")}</p>
                  </td>
                  <td>{w.vramMb} MB</td>
                  <td>
                    {w.healthStatus}
                    <p className="text-xs">{w.lastHealthCheck}</p>
                  </td>
                  <td>{w.maxConcurrentJobs}</td>
                  <td>
                    <button className="btn-secondary" onClick={() => toggle(w)}>
                      {w.enabled ? "Disable" : "Enable"}
                    </button>
                    <button
                      className="btn-secondary"
                      onClick={() => {
                        setEditing(w.id);
                        setForm({
                          name: w.name,
                          baseUrl: w.baseUrl,
                          gpuName: w.gpuName,
                          vramMb: w.vramMb,
                          maxConcurrentJobs: w.maxConcurrentJobs,
                          architecture: w.architecture,
                          tags: w.tags.join(","),
                        });
                      }}
                    >
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="card">
        <h2 className="font-bold">{editing ? "Edit worker" : "Register worker"}</h2>
        <form onSubmit={save} className="mt-3 grid grid-cols-2 gap-2">
          {Object.entries(form).map(([k, v]) => (
            <label key={k}>
              {k}
              <input
                className="input"
                type={typeof v === "number" ? "number" : "text"}
                value={v}
                onChange={(e) =>
                  setForm({ ...form, [k]: typeof v === "number" ? Number(e.target.value) : e.target.value })
                }
              />
            </label>
          ))}
          <button type="submit" className="btn">
            {editing ? "Save" : "Register"}
          </button>
        </form>
        {msg && <p role="status">{msg}</p>}
      </div>
    </div>
  );
}
