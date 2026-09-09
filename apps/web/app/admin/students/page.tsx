"use client";
import { useEffect, useState } from "react";

export default function StudentsPage() {
  const [users, setUsers] = useState<
    Array<{ id: string; email: string; firstName: string; lastName: string; globalRole: string; status: string }>
  >([]);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  async function load() {
    const r = await fetch(`/api/admin/users?q=${encodeURIComponent(q)}`);
    if (r.ok) setUsers((await r.json()).users ?? []);
  }
  useEffect(() => {
    load();
  }, []);
  async function setStatus(id: string, status: string) {
    const response = await fetch(`/api/admin/users?id=${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (!response.ok) setError((await response.json()).error);
    load();
  }
  return (
    <div className="card">
      <h1 className="text-xl font-bold">Students</h1>
      {error && <p role="alert">{error}</p>}
      <div className="mt-2 flex gap-2">
        <input className="input" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn-secondary" onClick={load}>
          Search
        </button>
      </div>
      <table className="data mt-3">
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Role</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>
                {u.firstName} {u.lastName}
              </td>
              <td>{u.email}</td>
              <td>{u.globalRole}</td>
              <td>{u.status}</td>
              <td className="flex gap-1">
                <button
                  className="btn-secondary"
                  onClick={() => setStatus(u.id, u.status === "ACTIVE" ? "DISABLED" : "ACTIVE")}
                >
                  {u.status === "ACTIVE" ? "Disable" : "Enable"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
