"use client";
import Link from "next/link";
import { useEffect, useState } from "react";

interface ClassItem {
  id: string;
  name: string;
  courseCode: string;
  term: string;
  slug: string;
  active: boolean;
  paused?: boolean;
  h3Video?: boolean;
  enrolled?: number;
  registered?: number;
}

export default function ClassesPage() {
  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [form, setForm] = useState({
    name: "Web Programming",
    courseCode: "CSCI 4300",
    term: "Fall 2026",
    description: "",
    slug: "csci4300-fall-2026",
  });
  const [h3Video, setH3Video] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function load() {
    const r = await fetch("/api/admin/classes");
    if (r.ok) setClasses((await r.json()).classes ?? []);
  }
  useEffect(() => {
    void load();
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const r = await fetch("/api/admin/classes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...form, h3Video }),
    });
    const j = await r.json();
    if (!r.ok) setMsg(j.error);
    else {
      setMsg("Created");
      void load();
    }
  }

  async function togglePause(c: ClassItem) {
    const r = await fetch(`/api/admin/classes/${c.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paused: !c.paused }),
    });
    if (!r.ok) setMsg((await r.json()).error);
    void load();
  }

  async function toggleH3(c: ClassItem) {
    const r = await fetch(`/api/admin/classes/${c.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ h3Video: !c.h3Video }),
    });
    if (!r.ok) setMsg((await r.json()).error);
    void load();
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
          <label className="col-span-2 mt-1 flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={h3Video} onChange={(e) => setH3Video(e.target.checked)} />
            Enable H3 example workflows for all students (active immediately, even before students sign up)
          </label>
          <div className="col-span-2 mt-1">
            <button className="btn" type="submit">
              Create
            </button>
          </div>
        </form>
        {msg && <p className="mt-2 text-sm">{msg}</p>}
      </div>
      <div className="card">
        {classes.length === 0 && <p className="text-sm text-slate-600">No classes created yet.</p>}
        {classes.map((c) => (
          <div key={c.id} className="flex flex-wrap items-center justify-between gap-2 border-b py-3 last:border-b-0">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <Link className="font-medium underline" href={`/admin/classes/${c.id}`}>
                  {c.courseCode} — {c.term}
                </Link>
                <span
                  className={`rounded px-2 py-0.5 text-xs font-semibold ${
                    !c.active
                      ? "bg-slate-200 text-slate-700"
                      : c.paused
                        ? "bg-amber-100 text-amber-800"
                        : "bg-emerald-100 text-emerald-800"
                  }`}
                >
                  {!c.active ? "Archived" : c.paused ? "Access disabled" : "Access enabled"}
                </span>
                {c.h3Video && (
                  <span className="rounded bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-800">
                    H3 enabled for all
                  </span>
                )}
              </div>
              <div className="mt-0.5 text-sm text-slate-600">
                {c.name} · {c.slug} · {c.registered ?? 0}/{c.enrolled ?? 0} registered
              </div>
            </div>
            {c.active && (
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" className="btn-secondary text-sm" onClick={() => toggleH3(c)}>
                  {c.h3Video ? "Disable H3 for all" : "Enable H3 for all"}
                </button>
                <button
                  type="button"
                  className={
                    c.paused ? "btn text-sm" : "btn-secondary border-amber-300 text-sm text-amber-900 hover:bg-amber-50"
                  }
                  onClick={() => togglePause(c)}
                >
                  {c.paused ? "Enable class access" : "Disable class access"}
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
