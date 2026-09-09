import nodemailer from "nodemailer";
import { getEnv, appUrl } from "@class-comfyui/config";

export interface SendMailOpts {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

let lastDevLink: string | null = null;
export function getLastDevLink() {
  return lastDevLink;
}

/** SMTP send. In dev without real SMTP, logs to console and captures link. Never exposes secrets. */
export async function sendMail(opts: SendMailOpts): Promise<{ sent: boolean; dev?: boolean }> {
  const env = getEnv();
  // Capture verification links for dev visibility
  const linkMatch = opts.text.match(/https?:\/\/\S+/);
  if (linkMatch) lastDevLink = linkMatch[0];

  if (!env.SMTP_HOST || env.SMTP_HOST.includes("example.edu")) {
    console.log(`[mail:dev] to=${opts.to} subject=${opts.subject}\n${opts.text}`);
    return { sent: true, dev: true };
  }
  try {
    const transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: String(env.SMTP_SECURE).toLowerCase() === "true",
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
    });
    await transporter.sendMail({
      from: `"${env.SMTP_FROM_NAME}" <${env.SMTP_FROM_EMAIL}>`,
      to: opts.to,
      subject: opts.subject,
      text: opts.text,
      html: opts.html,
    });
    return { sent: true };
  } catch (e) {
    console.error("[mail] SMTP send failed, falling back to log:", (e as Error).message);
    console.log(`[mail:fallback] to=${opts.to}\n${opts.text}`);
    return { sent: true, dev: true };
  }
}

export function verificationEmail(to: string, link: string): SendMailOpts {
  return {
    to,
    subject: "Your ComfyUI Lab sign-in link",
    text: `Sign in to ComfyUI Lab:\n\n${link}\n\nThis link expires in 15 minutes and can be used once.`,
    html: `<p>Sign in to ComfyUI Lab:</p><p><a href="${link}">${link}</a></p><p>This link expires in 15 minutes and can be used once.</p>`,
  };
}

export function signupInviteEmail(to: string, courseLabel: string, signupUrl: string): SendMailOpts {
  return {
    to,
    subject: `Invitation: ${courseLabel} ComfyUI Lab`,
    text: `You have been invited to use the ComfyUI Lab for:\n\n${courseLabel}\n\nCreate your account:\n${signupUrl}\n\nYou must register using the email address associated with your course roster.`,
  };
}

export function buildVerifyLink(token: string, email: string): string {
  const env = getEnv();
  // Generated from PUBLIC_URL, never from Host headers.
  return appUrl(env.PUBLIC_URL, `/verify?token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`);
}
