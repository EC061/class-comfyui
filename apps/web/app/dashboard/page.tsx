import { redirect } from "next/navigation";
// The landing page serves both roles now.
export default function DashboardRedirect() {
  redirect("/");
}
