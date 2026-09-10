import { redirect } from "next/navigation";
// Administrator metrics live on the shared landing page.
export default function AdminHomeRedirect() {
  redirect("/");
}
