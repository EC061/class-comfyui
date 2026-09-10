"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState, Suspense } from "react";

/**
 * Password recovery, and the way an account created before password sign-in
 * existed chooses its first password. Without a token this only requests the
 * email; with one it sets the new password.
 */
function ResetInner() {
  const params = useSearchParams();
  const token = params.get("token") ?? "";
  const [email, setEmail] = useState(params.get("email") ?? "");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function request(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    const r = await fetch("/api/auth/password-reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (r.ok) setNotice(j.message ?? "Check your email.");
    else setError(j.error ?? "Request failed");
  }

  async function confirmReset(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError("The two passwords do not match");
      return;
    }
    setBusy(true);
    const r = await fetch("/api/auth/password-reset/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, token, password }),
    });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (r.ok) {
      setDone(true);
      setNotice(j.message ?? "Password updated.");
    } else setError(j.error ?? "Could not set the password");
  }

  if (done)
    return (
      <div className="card mx-auto max-w-md">
        <h1 className="text-xl font-bold">Password updated</h1>
        <p role="status" className="mt-2 text-sm">
          {notice}
        </p>
        <Link className="btn mt-4" href="/login">
          Sign in
        </Link>
      </div>
    );

  return (
    <div className="card mx-auto max-w-md">
      <h1 className="text-xl font-bold">{token ? "Choose a new password" : "Reset your password"}</h1>
      {token ? (
        <form onSubmit={confirmReset} className="mt-4 grid gap-3">
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
            <label className="label" htmlFor="password">
              New password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="new-password"
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={12}
              required
            />
            <p className="mt-1 text-xs text-slate-500">At least 12 characters.</p>
          </div>
          <div>
            <label className="label" htmlFor="confirm">
              Confirm new password
            </label>
            <input
              id="confirm"
              type="password"
              autoComplete="new-password"
              className="input"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              minLength={12}
              required
            />
          </div>
          <button className="btn" type="submit" disabled={busy}>
            {busy ? "Saving…" : "Set password"}
          </button>
          <p className="text-xs text-slate-500">Setting a password signs out every other session.</p>
        </form>
      ) : (
        <form onSubmit={request} className="mt-4 grid gap-3">
          <p className="text-sm text-slate-600">We email a one-time link to choose a new password.</p>
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
              placeholder="you@example.edu"
              required
            />
          </div>
          <button className="btn" type="submit" disabled={busy}>
            {busy ? "Sending…" : "Email me a link"}
          </button>
        </form>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-600">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="mt-3 text-sm">
          {notice}
        </p>
      )}
      <p className="mt-4 text-sm text-slate-600">
        <Link className="underline" href="/login">
          Back to sign in
        </Link>
      </p>
    </div>
  );
}

export default function ResetPage() {
  return (
    <Suspense>
      <ResetInner />
    </Suspense>
  );
}
