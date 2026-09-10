"use client";
import Link from "next/link";
import { useState } from "react";

/** One sign-in form for students and administrators alike. */
export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setCode(null);
    setBusy(true);
    const r = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (r.ok) {
      // A full navigation, so the server re-renders the role-aware navigation.
      window.location.assign("/");
      return;
    }
    setError(j.error ?? "Sign-in failed");
    setCode(j.code ?? null);
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
      <h1 className="text-xl font-bold">Sign in</h1>
      <p className="mt-1 text-sm text-slate-600">Students and administrators sign in here.</p>
      <form onSubmit={submit} className="mt-4 grid gap-3">
        <div>
          <label className="label" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            className="input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.edu"
            required
          />
        </div>
        <div>
          <label className="label" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            className="input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <button className="btn" type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-600">
          {error}
        </p>
      )}
      {code === "PENDING" && (
        <button className="btn-secondary mt-2" onClick={resend}>
          Resend activation email
        </button>
      )}
      {notice && <p className="mt-2 text-sm">{notice}</p>}
      <p className="mt-4 text-sm text-slate-600">
        <Link className="underline" href="/reset">
          Forgot your password?
        </Link>{" "}
        ·{" "}
        <Link className="underline" href="/register">
          Create an account
        </Link>
      </p>
      <p className="mt-2 text-xs text-slate-500">
        If your account predates password sign-in, use “Forgot your password?” once to choose one.
      </p>
    </div>
  );
}
