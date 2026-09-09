import "./globals.css";
import Link from "next/link";
import { getEnv, canonicalOrigin } from "@class-comfyui/config";

export const metadata = { title: "ComfyUI Lab", description: "Classroom management for centrally hosted ComfyUI" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="border-b bg-white">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
            <Link href="/" className="font-bold">
              ComfyUI Lab
            </Link>
            <nav className="flex gap-1 text-sm">
              <Link className="nav-link" href="/dashboard">
                Dashboard
              </Link>
              <Link className="nav-link" href="/admin">
                Admin
              </Link>
              <Link className="nav-link" href="/login">
                Login
              </Link>
              <Link className="nav-link" href="/register">
                Register
              </Link>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
        <footer className="mx-auto max-w-6xl px-4 pb-8 text-xs text-slate-500">
          Origin enforced against PUBLIC_URL ({canonicalOriginSafe()}).
        </footer>
      </body>
    </html>
  );
}

function canonicalOriginSafe(): string {
  try {
    return canonicalOrigin(getEnv().PUBLIC_URL);
  } catch {
    return "unconfigured";
  }
}
