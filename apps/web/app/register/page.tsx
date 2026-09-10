"use client";
import Link from "next/link";
import { useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";

interface ClassInfo {
  name: string;
  courseCode: string;
  term: string;
}

/**
 * One registration form for both roles. The role comes from what the visitor can
 * prove: a class signup link makes a student, the administrator registration code
 * makes an administrator. The password is chosen here; the account activates when
 * the emailed confirmation is opened, and that is the only email confirmation an
 * account ever needs.
 */
function RegisterInner() {
  const params = useSearchParams();
  const classSlug = params.get("slug") ?? "";
  const signupToken = params.get("token") ?? "";
  const hasClassLink = !!(classSlug && signupToken);

  const [info, setInfo] = useState<ClassInfo | null>(null);
  const [signedIn, setSignedIn] = useState<{ email: string; globalRole: string } | null | undefined>(undefined);
  const [form, setForm] = useState({ firstName: "", lastName: "", email: "", password: "", confirm: "" });
  const [adminCode, setAdminCode] = useState("");
  const [showAdmin, setShowAdmin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/auth/session").then(async (r) => {
      const j = r.ok ? await r.json() : {};
      setSignedIn(j.user ?? null);
    });
  }, []);

  useEffect(() => {
    if (!hasClassLink) return;
    fetch("/api/signup/info?" + new URLSearchParams({ slug: classSlug, token: signupToken })).then(async (r) => {
      if (r.ok) setInfo(await r.json());
      else setError("This signup link is invalid or disabled. Ask your instructor for a new one.");
    });
  }, [hasClassLink, classSlug, signupToken]);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (form.password !== form.confirm) {
      setError("The two passwords do not match");
      return;
    }
    setBusy(true);
    const r = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: form.email,
        password: form.password,
        firstName: form.firstName,
        lastName: form.lastName,
        ...(hasClassLink ? { classSlug, signupToken } : {}),
        ...(adminCode ? { adminCode } : {}),
      }),
    });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (r.ok) setDone(j.message ?? "Check your email to activate the account.");
    else setError(j.error ?? "Registration failed");
  }

  async function join() {
    setError(null);
    const r = await fetch("/api/enroll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ classSlug, signupToken }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) window.location.assign("/");
    else setError(j.error ?? "Could not join this class");
  }

  if (done)
    return (
      <div className="card mx-auto max-w-md">
        <h1 className="text-xl font-bold">Confirm your email</h1>
        <p role="status" className="mt-2 text-sm">
          {done}
        </p>
        <p className="mt-3 text-sm text-slate-600">
          Opening that link activates the account and signs you in. After that, only your email and password are ever
          needed.
        </p>
        <Link className="btn-secondary mt-4" href="/login">
          Go to sign in
        </Link>
      </div>
    );

  // Already signed in and following a class link: the address is already proven,
  // so joining needs no second account and no second confirmation email.
  if (signedIn && hasClassLink)
    return (
      <div className="card mx-auto max-w-md">
        <p className="text-xs uppercase tracking-wide text-slate-500">
          {info?.courseCode} · {info?.term}
        </p>
        <h1 className="mt-1 text-xl font-bold">Join {info?.name ?? "this class"}</h1>
        <p className="mt-2 text-sm text-slate-600">
          Signed in as {signedIn.email}. Your email must be on this class roster.
        </p>
        <button className="btn mt-4 disabled:opacity-50" disabled={!info} onClick={join}>
          Join class
        </button>
        {error && (
          <p role="alert" className="mt-3 text-sm text-red-600">
            {error}
          </p>
        )}
      </div>
    );

  if (signedIn)
    return (
      <div className="card mx-auto max-w-md">
        <h1 className="text-xl font-bold">Already signed in</h1>
        <p className="mt-2 text-sm text-slate-600">You are signed in as {signedIn.email}.</p>
        <Link className="btn mt-4" href="/">
          Go to your dashboard
        </Link>
      </div>
    );

  return (
    <div className="card mx-auto max-w-md">
      {hasClassLink && (
        <>
          <p className="text-xs uppercase tracking-wide text-slate-500">
            {info?.courseCode} · {info?.term}
          </p>
          <p className="text-sm">{info?.name}</p>
        </>
      )}
      <h1 className="mt-1 text-xl font-bold">Create your account</h1>
      <p className="mt-1 text-sm text-slate-600">
        {hasClassLink
          ? "Use the email address on your course roster."
          : "Registration needs a class signup link from your instructor, or the administrator registration code."}
      </p>
      <form onSubmit={submit} className="mt-4 grid gap-3">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="label" htmlFor="firstName">
              First name
            </label>
            <input id="firstName" className="input" value={form.firstName} onChange={set("firstName")} />
          </div>
          <div>
            <label className="label" htmlFor="lastName">
              Last name
            </label>
            <input id="lastName" className="input" value={form.lastName} onChange={set("lastName")} />
          </div>
        </div>
        <div>
          <label className="label" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            className="input"
            value={form.email}
            onChange={set("email")}
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
            type="password"
            autoComplete="new-password"
            className="input"
            value={form.password}
            onChange={set("password")}
            minLength={12}
            required
          />
          <p className="mt-1 text-xs text-slate-500">At least 12 characters.</p>
        </div>
        <div>
          <label className="label" htmlFor="confirm">
            Confirm password
          </label>
          <input
            id="confirm"
            type="password"
            autoComplete="new-password"
            className="input"
            value={form.confirm}
            onChange={set("confirm")}
            minLength={12}
            required
          />
        </div>
        {showAdmin ? (
          <div>
            <label className="label" htmlFor="adminCode">
              Administrator registration code
            </label>
            <input
              id="adminCode"
              type="password"
              autoComplete="off"
              className="input"
              value={adminCode}
              onChange={(e) => setAdminCode(e.target.value)}
            />
            <p className="mt-1 text-xs text-slate-500">
              The secret ADMIN_REGISTRATION_CODE from the deployment configuration.
            </p>
          </div>
        ) : (
          <button type="button" className="text-left text-sm underline" onClick={() => setShowAdmin(true)}>
            I have an administrator registration code
          </button>
        )}
        <button className="btn disabled:opacity-50" type="submit" disabled={busy || (hasClassLink && !info)}>
          {busy ? "Creating account…" : "Create account"}
        </button>
      </form>
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-600">
          {error}
        </p>
      )}
      <p className="mt-4 text-sm text-slate-600">
        <Link className="underline" href="/login">
          Already have an account? Sign in
        </Link>
      </p>
    </div>
  );
}

export default function RegisterPage() {
  return (
    <Suspense>
      <RegisterInner />
    </Suspense>
  );
}
