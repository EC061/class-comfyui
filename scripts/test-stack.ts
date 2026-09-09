// Disposable, loopback-only test services. Never use this mail inbox in production.
import { SMTPServer } from "smtp-server";
import { simpleParser } from "mailparser";
import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mockComfy } from "../tests/mock-comfy";
async function main() {
  const dir = mkdtempSync(path.join(tmpdir(), "comfy-e2e-")),
    messages: any[] = [];
  const children: ChildProcess[] = [];
  const env = {
    ...process.env,
    NODE_ENV: "production",
    PUBLIC_URL: "http://localhost:13000",
    COMFY_PUBLIC_URL: "http://localhost:18081",
    SQLITE_PATH: path.join(dir, "lab.sqlite"),
    AUDIT_DATA_DIR: path.join(dir, "audit"),
    UPLOAD_DATA_DIR: path.join(dir, "uploads"),
    AUTH_SECRET: "e2e-auth-secret-with-more-than-32-characters",
    WORKSPACE_JWT_SECRET: "e2e-workspace-secret-with-more-than-32-characters",
    ADMIN_REGISTRATION_CODE: "e2e-admin-code-with-more-than-32-characters",
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: "11025",
    SMTP_SECURE: "false",
    SMTP_USER: "",
    SMTP_PASSWORD: "",
    PORT: "13000",
    GATEWAY_PORT: "18081",
    HOSTNAME: "127.0.0.1",
  };
  const smtp = new SMTPServer({
    authOptional: true,
    disabledCommands: ["AUTH", "STARTTLS"],
    onData(stream, session, callback) {
      simpleParser(stream)
        .then((m) => {
          messages.push({ to: session.envelope.rcptTo[0].address, text: m.text });
          callback();
        })
        .catch(callback);
    },
  });
  await new Promise<void>((r) => smtp.listen(11025, "127.0.0.1", r));
  const mock = await mockComfy(18188);
  function start(command: string, args: string[]) {
    const child = spawn(command, args, { env, stdio: ["ignore", "inherit", "inherit"] });
    children.push(child);
    return child;
  }
  mkdirSync("apps/web/.next/standalone/apps/web/.next", { recursive: true });
  cpSync("apps/web/.next/static", "apps/web/.next/standalone/apps/web/.next/static", { recursive: true });
  let web = start(process.execPath, ["apps/web/.next/standalone/apps/web/server.js"]);
  let gateway = start(process.execPath, ["apps/gateway/dist/index.cjs"]);
  const control = createServer(async (req, res) => {
    if (req.url === "/mail") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(messages));
      return;
    }
    if (req.url === "/restart" && req.method === "POST") {
      // Match Docker's bounded stop: an open browser connection must not hang
      // restart forever. SIGKILL also exercises SQLite crash recovery when needed.
      await Promise.all(
        [web, gateway].map(
          (child) =>
            new Promise<void>((resolve) => {
              if (child.exitCode !== null || child.signalCode !== null) return resolve();
              const deadline = setTimeout(() => child.kill("SIGKILL"), 10000);
              child.once("exit", () => {
                clearTimeout(deadline);
                resolve();
              });
              child.kill("SIGTERM");
            })
        )
      );
      web = start(process.execPath, ["apps/web/.next/standalone/apps/web/server.js"]);
      gateway = start(process.execPath, ["apps/gateway/dist/index.cjs"]);
      res.end("restarted");
      return;
    }
    res.end("test services ready");
  });
  await new Promise<void>((r) => control.listen(18325, "127.0.0.1", r));
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    for (const child of children) child.kill("SIGTERM");
    await mock.close();
    control.close();
    smtp.close();
    setTimeout(() => {
      rmSync(dir, { recursive: true, force: true });
      process.exit(0);
    }, 2500).unref();
  };
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());
}
void main();
