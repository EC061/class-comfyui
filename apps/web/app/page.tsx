import Link from "next/link";
import { sessionUser } from "@/lib/guards";
import { AdminOverview } from "@/components/admin-overview";
import { MyClasses } from "@/components/my-classes";
import { Jobs } from "@/components/jobs";

/**
 * The single entry point. One address serves both roles: what it renders is
 * decided from the signed-in account's role, and the API shapes the same job list
 * per role, so an administrator sees the whole lab and a student sees only their
 * own work.
 */
export default async function Home() {
  const user = await sessionUser();
  if (!user)
    return (
      <div className="grid gap-4">
        <div className="card">
          <h1 className="text-2xl font-bold">Centrally hosted ComfyUI for the classroom</h1>
          <p className="mt-2 text-sm text-slate-600">
            Sign in with your email and password. Students join with the signup link from their instructor;
            administrators join with the registration code. ComfyUI itself manages no accounts.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link className="btn" href="/login">
              Sign in
            </Link>
            <Link className="btn-secondary" href="/register">
              Create account
            </Link>
          </div>
        </div>
      </div>
    );

  const isAdmin = user.globalRole === "ADMIN";
  return (
    <div className="grid gap-4">
      <div>
        <h1 className="text-2xl font-bold">
          {user.firstName ? `Welcome, ${user.firstName}` : "Welcome"}
          {isAdmin && <span className="ml-2 align-middle text-sm font-normal text-slate-500">administrator</span>}
        </h1>
      </div>
      {isAdmin && <AdminOverview />}
      <MyClasses hideWhenEmpty={isAdmin} />
      <Jobs />
    </div>
  );
}
