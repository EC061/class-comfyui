import { requireAdmin } from "@/lib/guards";
export const dynamic = "force-dynamic";

/**
 * Every /admin route is gated here, on the server, before any markup exists.
 * A student who reaches one of these addresses is sent to their own landing page.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireAdmin();
  return <>{children}</>;
}
