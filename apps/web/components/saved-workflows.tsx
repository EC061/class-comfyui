"use client";
import { useEffect, useState } from "react";

interface SavedFile {
  id: string;
  className: string;
  path: string;
  size: number;
  modified: string;
  url: string;
}

/**
 * The signed-in account's own saved ComfyUI files. Served by the management app,
 * so they stay downloadable while a class's ComfyUI access is paused.
 */
export function SavedWorkflows() {
  const [files, setFiles] = useState<SavedFile[] | null>(null);
  useEffect(() => {
    fetch("/api/workflows")
      .then(async (r) => setFiles(r.ok ? ((await r.json()).files as SavedFile[]) : []))
      .catch(() => setFiles([]));
  }, []);
  if (!files || files.length === 0) return null;
  return (
    <div className="card">
      <h2 className="text-xl font-bold">Saved workflows</h2>
      <p className="mt-1 text-sm text-slate-600">
        Files you saved in ComfyUI. Download them any time, including while class access is paused.
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left">
              <th>File</th>
              <th>Class</th>
              <th>Saved</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {files.map((f) => (
              <tr key={f.id}>
                <td className="break-all font-mono text-xs">{f.path}</td>
                <td>{f.className}</td>
                <td className="text-xs">{new Date(f.modified).toLocaleString()}</td>
                <td>
                  <a className="underline" href={f.url}>
                    Download
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
