import nodemailer from "nodemailer";
import { getEnv, appUrl } from "@class-comfyui/config";
export interface SendMailOpts {
  to: string;
  subject: string;
  text: string;
}
export async function sendMail(opts: SendMailOpts) {
  const env = getEnv();
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE === "true",
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
    connectionTimeout: 10000,
    socketTimeout: 15000,
    greetingTimeout: 10000,
  });
  try {
    await transport.sendMail({ from: { name: env.SMTP_FROM_NAME, address: env.SMTP_FROM_EMAIL }, ...opts });
    return { sent: true };
  } catch {
    throw new Error("SMTP delivery failed");
  } finally {
    transport.close();
  }
}
export function buildVerifyLink(token: string, email: string) {
  return appUrl(getEnv().PUBLIC_URL, `/verify?token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`);
}
export function verificationEmail(to: string, link: string) {
  return {
    to,
    subject: "Your ComfyUI Lab sign-in link",
    text: `Use this one-time link to sign in:\n\n${link}\n\nExpires in ${getEnv().VERIFICATION_TTL_MINUTES} minutes. If you did not request this, ignore this email.`,
  };
}
export function signupInviteEmail(to: string, courseLabel: string, url: string) {
  return {
    to,
    subject: `Invitation: ${courseLabel} ComfyUI Lab`,
    text: `You have been invited to ${courseLabel}.\n\nCreate your account: ${url}\n\nRegister with the email associated with your course roster.`,
  };
}
