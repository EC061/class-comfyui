import Link from "next/link";
export default function Register() {
  return (
    <div className="card">
      <h1 className="text-xl font-bold">Student registration</h1>
      <p className="my-3">Use the signup link provided by your instructor. Your email must be on that class roster.</p>
      <Link className="underline" href="/login">
        Already registered? Log in
      </Link>
    </div>
  );
}
