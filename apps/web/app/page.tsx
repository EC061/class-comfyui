import Link from "next/link";

export default function Home() {
  return (
    <div className="grid gap-4">
      <div className="card">
        <h1 className="text-2xl font-bold">Centrally hosted ComfyUI for the classroom</h1>
        <p className="mt-2 text-sm text-slate-600">
          Students authenticate here with passwordless email, enroll via a roster-gated class signup link, then open
          ComfyUI through an authenticated gateway. ComfyUI never manages accounts.
        </p>
        <div className="mt-4 flex gap-2">
          <Link className="btn" href="/register">
            Student registration
          </Link>
          <Link className="btn-secondary" href="/login">
            Log in
          </Link>
          <Link className="btn-secondary" href="/register/admin">
            Admin registration
          </Link>
        </div>
      </div>
      <div className="card text-sm text-slate-600">
        <strong>Administrators:</strong> register with the secret code, create a class, upload the roster CSV, generate
        the signup URL, register GPU workers — then students can sign up and run jobs with full audit archival.
      </div>
    </div>
  );
}
