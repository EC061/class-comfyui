"use client";
import { useState } from "react";

export default function RegisterPage() {
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    const r = await fetch("/api/auth/request-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const j = await r.json();
    setMsg(r.ok ? (j.message ?? "Check your email") : (j.error ?? "Failed"));
  }

  return (
    <div className="card mx-auto max-w-md">
      <h1 className="text-xl font-bold">Student registration</h1>
      <p className="mt-1 text-sm text-slate-600">
        Enter your university email. It must appear in an active class roster — otherwise registration is denied. Prefer
        your class signup link if you have one.
      </p>
      <form onSubmit={submit} className="mt-4 grid gap-3">
        <div>
          <label className="label">University email</label>
          <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <button className="btn" type="submit">
          Continue
        </button>
      </form>
      {msg && <p className="mt-3 text-sm">{msg}</p>}
    </div>
  );
}
