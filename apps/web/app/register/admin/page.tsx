"use client";
import { useState } from "react";

export default function AdminRegisterPage() {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    const r = await fetch("/api/auth/request-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, isAdmin: true, adminCode: code, firstName, lastName }),
    });
    const j = await r.json();
    setMsg(r.ok ? `${j.message} ${j.devLink ? `Dev: ${j.devLink}` : ""}` : (j.error ?? "Failed"));
  }

  return (
    <div className="card mx-auto max-w-md">
      <h1 className="text-xl font-bold">Admin registration</h1>
      <p className="mt-1 text-sm text-slate-600">
        Requires the secret ADMIN_REGISTRATION_CODE configured in Docker Compose.
      </p>
      <form onSubmit={submit} className="mt-4 grid gap-3">
        <div>
          <label className="label">Email</label>
          <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="label">First name</label>
            <input className="input" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
          </div>
          <div>
            <label className="label">Last name</label>
            <input className="input" value={lastName} onChange={(e) => setLastName(e.target.value)} />
          </div>
        </div>
        <div>
          <label className="label">Admin registration code</label>
          <input className="input" type="password" value={code} onChange={(e) => setCode(e.target.value)} required />
        </div>
        <button className="btn" type="submit">
          Request verification
        </button>
      </form>
      {msg && <p className="mt-3 break-words text-sm">{msg}</p>}
    </div>
  );
}
