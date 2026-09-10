import { redirect } from "next/navigation";

/**
 * Signup links already in students' inboxes keep working: they carry the class
 * context into the single registration page.
 */
export default async function SignupRedirect({
  params,
}: {
  params: Promise<{ classSlug: string; signupToken: string }>;
}) {
  const { classSlug, signupToken } = await params;
  redirect(`/register?${new URLSearchParams({ slug: classSlug, token: signupToken })}`);
}
