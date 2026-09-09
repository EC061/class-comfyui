import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionUserIdFromCookie } from "@/lib/session";
import { getDb } from "@class-comfyui/database";
export const dynamic = "force-dynamic";
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const jar = await cookies(),
    id = getSessionUserIdFromCookie(jar.toString());
  if (!id) redirect("/login");
  if (getDb().get("users", id)?.globalRole !== "ADMIN") redirect("/dashboard");
  return (
    <>
      <nav className="mb-4 flex flex-wrap gap-2">
        {["Dashboard", "Classes", "Students", "Jobs", "Workers", "Audit", "Settings"].map((label) => (
          <Link
            key={label}
            className="nav-link border"
            href={label === "Dashboard" ? "/admin" : "/admin/" + label.toLowerCase()}
          >
            {label}
          </Link>
        ))}
      </nav>
      {children}
    </>
  );
}
