import { requireUser } from "@/lib/guards";
export const dynamic = "force-dynamic";

/** Job detail is for signed-in accounts; the API further restricts it to the owner. */
export default async function JobsLayout({ children }: { children: React.ReactNode }) {
  await requireUser();
  return <>{children}</>;
}
