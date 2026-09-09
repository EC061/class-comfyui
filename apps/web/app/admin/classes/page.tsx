"use client";
import Link from "next/link";
import { useEffect, useState } from "react";

export default function ClassesPage() {
  const [classes, setClasses] = useState<
    Array<{ id: string; name: string; courseCode: string; term: string; slug: string; active: boolean }>
  >([]);
  const [form, setForm] = useState({
    name: "Web Programming",
    courseCode: "CSCI 4300",
    term: "Fall 2026",
    description: "",
    slug: "csci4300-fall-2026",
  });
  const [msg, setMsg] = useState<string | null>(null);

  async function load() {
    const r = await fetch("/api/admin/classes");
    if (r.ok) setClasses((await r.json()).classes ?? []);
  }
  useEffect(() => {
    load();
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const r = await fetch("/api/admin/classes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    const j = await r.json();
    if (!r.ok) setMsg(j.error);
    else {
      setMsg("Created");
      load();
    }
  }

  return (
    <div className="grid gap-4">
      <h1 className="text-xl font-bold">Classes</h1>
      <div className="card">
        <h2 className="font-bold">Create class</h2>
        <form onSubmit={create} className="mt-2 grid grid-cols-2 gap-2">
          {Object.entries(form).map(([k, v]) => (
            <div key={k}>
              <label className="label">{k}</label>
              <input className="input" value={v} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
            </div>
          ))}
          <div className="col-span-2">
            <button className="btn" type="submit">
              Create
            </button>
          </div>
        </form>
        {msg && <p className="mt-2 text-sm">{msg}</p>}
      </div>
      <div className="card">
        {classes.map((c) => (
          <div key={c.id} className="flex items-center justify-between border-b py-2">
            <div>
              <Link className="font-medium underline" href={`/admin/classes/${c.id}`}>
                {c.courseCode} — {c.term}
              </Link>
              <div className="text-sm text-slate-600">
                {c.name} · {c.slug} · {c.active ? "active" : "archived"}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
