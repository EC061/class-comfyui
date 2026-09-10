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
export function buildActivationLink(token: string, email: string) {
  return appUrl(getEnv().PUBLIC_URL, `/verify?token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`);
}
export function buildResetLink(token: string, email: string) {
  return appUrl(getEnv().PUBLIC_URL, `/reset?token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`);
}
export function activationEmail(to: string, link: string) {
  return {
    to,
    subject: "Activate your ComfyUI Lab account",
    text: `Your password is set. Confirm this address once to activate the account:\n\n${link}\n\nExpires in ${getEnv().VERIFICATION_TTL_MINUTES} minutes. After activation you sign in with your email and password; no further email confirmation is needed.\n\nIf you did not create this account, ignore this email — the account stays inactive.`,
  };
}
export function passwordResetEmail(to: string, link: string) {
  return {
    to,
    subject: "Set your ComfyUI Lab password",
    text: `Use this one-time link to choose a new password:\n\n${link}\n\nExpires in ${getEnv().VERIFICATION_TTL_MINUTES} minutes. Setting a password here also confirms this address and signs out other sessions.\n\nIf you did not request this, ignore this email — your current password keeps working.`,
  };
}
export function signupInviteEmail(to: string, courseLabel: string, url: string) {
  return {
    to,
    subject: `Invitation: ${courseLabel} ComfyUI Lab`,
    text: `You have been invited to ${courseLabel}.\n\nCreate your account: ${url}\n\nRegister with the email address on your course roster, choose a password, then confirm the address once.`,
  };
}
