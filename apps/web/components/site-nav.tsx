"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const adminLinks = [
  ["/admin/classes", "Classes"],
  ["/admin/students", "Students"],
  ["/admin/jobs", "Jobs"],
  ["/admin/workers", "Workers"],
  ["/admin/audit", "Audit"],
  ["/admin/settings", "Settings"],
] as const;

export function SiteNav({ user }: { user: { email: string; globalRole: string } | null }) {
  const pathname = usePathname();
  // One navigation for both roles: the links an account cannot use are not rendered
  // at all, and the server refuses those routes independently.
  const links: Array<readonly [string, string]> = user
    ? [["/", "Home"], ...(user.globalRole === "ADMIN" ? adminLinks : [])]
    : [
        ["/login", "Sign in"],
        ["/register", "Create account"],
      ];
  return (
    <header className="border-b bg-white">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-3">
        <Link href="/" className="font-bold">
          ComfyUI Lab
        </Link>
        <nav className="flex flex-wrap items-center gap-1 text-sm">
          {links.map(([href, label]) => (
            <Link
              key={href}
              href={href}
              className={`nav-link ${pathname === href ? "nav-link-active" : ""}`}
              aria-current={pathname === href ? "page" : undefined}
            >
              {label}
            </Link>
          ))}
          {user && (
            <>
              <span className="px-2 text-slate-500">
                {user.email}
                {user.globalRole === "ADMIN" && <span className="ml-1 font-semibold text-slate-700">· admin</span>}
              </span>
              <button className="btn-secondary" onClick={signOut}>
                Sign out
              </button>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}

// A fetch, not a form POST: the API requires a same-origin Origin header, which a
// plain form submission does not send.
async function signOut() {
  await fetch("/api/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" } });
  window.location.assign("/login");
}
