import { redirect } from "next/navigation";
// Administrators and students register on the same page; the code decides the role.
export default function AdminRegisterRedirect() {
  redirect("/register");
}
