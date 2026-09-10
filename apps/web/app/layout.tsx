import "./globals.css";
import { SiteNav } from "@/components/site-nav";
import { sessionUser } from "@/lib/guards";

export const metadata = { title: "ComfyUI Lab", description: "Classroom management for centrally hosted ComfyUI" };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await sessionUser();
  return (
    <html lang="en">
      <body>
        <SiteNav user={user && { email: user.email, globalRole: user.globalRole }} />
        <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
