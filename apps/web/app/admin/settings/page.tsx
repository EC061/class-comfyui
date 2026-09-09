"use client";
import { useEffect, useState } from "react";

export default function SettingsPage() {
  const [to, setTo] = useState("admin@example.edu");
  const [msg, setMsg] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("");

  useEffect(() => {
    fetch("/api/smtp/test").then(async (r) => {
      if (r.ok) setStatus(JSON.stringify(await r.json()));
    });
  }, []);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const r = await fetch("/api/smtp/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to }),
    });
    const j = await r.json();
    setMsg(r.ok ? j.message : j.error);
  }

  return (
    <div className="card">
      <h1 className="text-xl font-bold">Settings</h1>
      <p className="mt-1 text-sm text-slate-600">SMTP status (safe, no secrets): {status || "…"}</p>
      <form onSubmit={send} className="mt-3 flex gap-2">
        <input className="input" value={to} onChange={(e) => setTo(e.target.value)} />
        <button className="btn" type="submit">
          Send test email
        </button>
      </form>
      {msg && <p className="mt-2 text-sm">{msg}</p>}
    </div>
  );
}
