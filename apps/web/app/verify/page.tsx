"use client";
import { useSearchParams, useRouter } from "next/navigation";
import { useState, Suspense } from "react";

function VerifyInner() {
  const params = useSearchParams();
  const router = useRouter();
  const [email, setEmail] = useState(params.get("email") ?? "");
  const [token, setToken] = useState(params.get("token") ?? "");
  const [msg, setMsg] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const r = await fetch("/api/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, token }),
    });
    const j = await r.json();
    if (!r.ok) setMsg(j.error ?? "Verification failed");
    else {
      setMsg("Verified. Redirecting…");
      router.push(j.role === "ADMIN" ? "/admin" : "/dashboard");
    }
  }

  return (
    <div className="card mx-auto max-w-md">
      <h1 className="text-xl font-bold">Verify email</h1>
      <form onSubmit={submit} className="mt-4 grid gap-3">
        <div>
          <label className="label">Email</label>
          <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div>
          <label className="label">Token (from link)</label>
          <input className="input" value={token} onChange={(e) => setToken(e.target.value)} required />
        </div>
        <button className="btn" type="submit">
          Verify
        </button>
      </form>
      {msg && <p className="mt-3 text-sm">{msg}</p>}
    </div>
  );
}

export default function VerifyPage() {
  return (
    <Suspense>
      <VerifyInner />
    </Suspense>
  );
}
