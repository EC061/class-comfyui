"use client";
import { useState } from "react";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [devLink, setDevLink] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setDevLink(null);
    const r = await fetch("/api/auth/request-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const j = await r.json();
    if (!r.ok) setMsg(j.error ?? "Failed");
    else {
      setMsg(j.message ?? "Check your email");
      if (j.devLink) setDevLink(j.devLink);
    }
  }

  return (
    <div className="card mx-auto max-w-md">
      <h1 className="text-xl font-bold">Log in</h1>
      <p className="mt-1 text-sm text-slate-600">Passwordless — we email you a one-time sign-in link.</p>
      <form onSubmit={submit} className="mt-4 grid gap-3">
        <div>
          <label className="label">Email</label>
          <input
            className="input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.edu"
            required
          />
        </div>
        <button className="btn" type="submit">
          Send sign-in link
        </button>
      </form>
      {msg && <p className="mt-3 text-sm">{msg}</p>}
      {devLink && (
        <p className="mt-2 text-sm">
          Dev link:{" "}
          <a className="underline" href={devLink}>
            {devLink}
          </a>
        </p>
      )}
    </div>
  );
}
