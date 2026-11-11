"use client";
import { useEffect, useState } from "react";

export function OpenComfyButton({ className = "btn", label = "Open ComfyUI" }: { className?: string; label?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onPageShow = () => setBusy(false);
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  async function launch() {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/workspace/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.url) {
        setError(j.error ?? "Could not open ComfyUI");
        setBusy(false);
        return;
      }
      window.location.href = j.url;
    } catch {
      setError("Could not reach server to open ComfyUI");
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-start">
      <button type="button" className={className} disabled={busy} onClick={launch}>
        {busy ? "Opening…" : label}
      </button>
      {error && (
        <span role="alert" className="mt-1 text-xs text-red-600">
          {error}
        </span>
      )}
    </span>
  );
}
