"use client";
import { use, useState, useEffect } from "react";

export default function SignupPage({
  params: asyncParams,
}: {
  params: Promise<{ classSlug: string; signupToken: string }>;
}) {
  const params = use(asyncParams);
  const [info, setInfo] = useState<{ name: string; courseCode: string; term: string } | null>(null);
  useEffect(() => {
    fetch("/api/signup/info?" + new URLSearchParams({ slug: params.classSlug, token: params.signupToken })).then(
      async (r) => {
        if (r.ok) setInfo(await r.json());
        else setMsg("Invalid or disabled signup link");
      }
    );
  }, [params.classSlug, params.signupToken]);
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    const r = await fetch("/api/signup/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, classSlug: params.classSlug, signupToken: params.signupToken }),
    });
    const j = await r.json();
    setMsg(r.ok ? j.message : (j.error ?? "Failed"));
  }

  return (
    <div className="card mx-auto max-w-md">
      <p className="text-xs uppercase tracking-wide text-slate-500">
        {info?.courseCode} · {info?.term}
      </p>
      <p>{info?.name}</p>
      <h1 className="mt-1 text-xl font-bold">Create your ComfyUI Lab account</h1>
      <p className="mt-1 text-sm text-slate-600">
        Use the email address on your course roster. A verification email proves ownership.
      </p>
      <form onSubmit={submit} className="mt-4 grid gap-3">
        <div>
          <label className="label">University email</label>
          <input
            className="input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.edu"
            required
          />
        </div>
        <button disabled={!info} className="btn disabled:opacity-50" type="submit">
          Continue
        </button>
      </form>
      {msg && <p className="mt-3 text-sm">{msg}</p>}
    </div>
  );
}
