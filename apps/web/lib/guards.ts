import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDb, type User } from "@class-comfyui/database";
import { getSessionUserIdFromCookie } from "./session";

/**
 * Server-side role gates. Every page and layout that is not public calls one of
 * these, so authorization is decided on the server before any markup is produced.
 * The middleware's cookie check only avoids a wasted render; it is not the gate.
 */
export async function sessionUser(): Promise<User | null> {
  const jar = await cookies();
  const id = getSessionUserIdFromCookie(jar.toString());
  return id ? (getDb().get("users", id) ?? null) : null;
}

export async function requireUser(): Promise<User> {
  const user = await sessionUser();
  if (!user) redirect("/login");
  return user;
}

export async function requireAdmin(): Promise<User> {
  const user = await requireUser();
  if (user.globalRole !== "ADMIN") redirect("/");
  return user;
}
