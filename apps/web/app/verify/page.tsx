"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState, Suspense } from "react";

/**
 * The one-time activation step. The emailed link is a GET, so it only presents
 * this confirmation; the challenge is consumed by the POST behind the button.
 */
function VerifyInner() {
  const params = useSearchParams();
  const [email, setEmail] = useState(params.get("email") ?? "");
  const [token, setToken] = useState(params.get("token") ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const r = await fetch("/api/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, token }),
    });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (r.ok) {
      window.location.assign("/");
      return;
    }
    setError(j.error ?? "Activation failed");
  }

  async function resend() {
    setNotice(null);
    const r = await fetch("/api/auth/resend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const j = await r.json().catch(() => ({}));
    setNotice(r.ok ? j.message : (j.error ?? "Could not resend"));
  }

  return (
    <div className="card mx-auto max-w-md">
      <h1 className="text-xl font-bold">Activate your account</h1>
      <p className="mt-1 text-sm text-slate-600">
        This confirms your email address once. Afterwards you sign in with your password.
      </p>
      <form onSubmit={submit} className="mt-4 grid gap-3">
        <div>
          <label className="label" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            type="email"
            className="input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div>
          <label className="label" htmlFor="token">
            Token (from the link)
          </label>
          <input id="token" className="input" value={token} onChange={(e) => setToken(e.target.value)} required />
        </div>
        <button className="btn" type="submit" disabled={busy}>
          {busy ? "Activating…" : "Activate account"}
        </button>
      </form>
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-600">
          {error}
        </p>
      )}
      {error && (
        <button className="btn-secondary mt-2" onClick={resend}>
          Send a new activation link
        </button>
      )}
      {notice && <p className="mt-2 text-sm">{notice}</p>}
      <p className="mt-4 text-sm text-slate-600">
        <Link className="underline" href="/login">
          Back to sign in
        </Link>
      </p>
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
