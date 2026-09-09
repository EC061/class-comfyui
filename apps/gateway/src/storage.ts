import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHash, randomUUID } from "node:crypto";
import { getEnv } from "@class-comfyui/config";
import { getDb, type Job, type Worker, type Output } from "@class-comfyui/database";
import { sanitizePathSegment } from "@class-comfyui/shared";
export function archiveDirectory(job: Job) {
  const c = getDb().get("classes", job.classId);
  const date = new Date(job.submittedAt);
  return path.resolve(
    getEnv().AUDIT_DATA_DIR,
    sanitizePathSegment(c?.slug || job.classId),
    sanitizePathSegment(job.orgDefinedId || job.userId),
    String(date.getUTCFullYear()),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
    job.id
  );
}
export async function workerFetch(
  worker: Worker,
  route: string,
  init: RequestInit = {},
  timeout = getEnv().WORKER_REQUEST_TIMEOUT_MS
) {
  return fetch(worker.baseUrl + route, { ...init, redirect: "error", signal: AbortSignal.timeout(timeout) });
}
export async function archive(job: Job, worker: Worker, entry: Record<string, any>) {
  const db = getDb(),
    dir = archiveDirectory(job);
  await fsp.mkdir(path.join(dir, "outputs"), { recursive: true, mode: 0o700 });
  await fsp.writeFile(
    path.join(dir, "api_prompt.json"),
    JSON.stringify(job.submittedPromptJson || job.promptJson, null, 2)
  );
  await fsp.writeFile(path.join(dir, "execution_prompt.json"), JSON.stringify(job.promptJson, null, 2));
  if (job.workflowJson) await fsp.writeFile(path.join(dir, "workflow.json"), JSON.stringify(job.workflowJson, null, 2));
  const safeHistory = structuredClone(entry);
  safeHistory.prompt = [0, job.id, job.promptJson, { extra_pnginfo: { workflow: job.workflowJson } }, []];
  let totalBytes = 0;
  const manifest: Output[] = [];
  try {
    for (const value of Object.values(safeHistory.outputs ?? {}) as any[]) {
      for (const [kind, files] of Object.entries(value)) {
        if (!Array.isArray(files)) continue;
        for (let index = 0; index < files.length; index++) {
          const meta = files[index] as any;
          if (!meta || typeof meta.filename !== "string") continue;
          if (
            meta.filename !== path.basename(meta.filename) ||
            meta.filename.includes("\\") ||
            String(meta.subfolder || "")
              .split(/[\\/]/)
              .includes("..")
          )
            throw new Error("Unsafe worker output path");
          const id = randomUUID(),
            ext = path
              .extname(meta.filename)
              .replace(/[^a-zA-Z0-9.]/g, "")
              .slice(0, 12),
            filename = id + ext;
          const dest = path.join(dir, "outputs", filename),
            tmp = dest + ".part";
          const response = await workerFetch(
            worker,
            "/view?" +
              new URLSearchParams({
                filename: meta.filename,
                subfolder: meta.subfolder || "",
                type: meta.type || "output",
              }),
            {},
            Math.max(getEnv().WORKER_REQUEST_TIMEOUT_MS, 600000)
          );
          if (!response.ok || !response.body) throw new Error("Output download failed");
          const hash = createHash("sha256");
          let size = 0;
          const counter = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              size += chunk.length;
              totalBytes += chunk.length;
              if (totalBytes > getEnv().MAX_ARCHIVE_MB * 1024 * 1024)
                return callback(new Error("Archive size limit exceeded"));
              hash.update(chunk);
              callback(null, chunk);
            },
          });
          try {
            await pipeline(
              Readable.fromWeb(response.body as any),
              counter,
              fs.createWriteStream(tmp, { flags: "wx", mode: 0o600 })
            );
            await fsp.rename(tmp, dest);
          } catch (e) {
            await fsp.rm(tmp, { force: true });
            throw e;
          }
          const output: Output = {
            id,
            jobId: job.id,
            fileName: filename,
            originalFilename: meta.filename,
            subfolder: meta.subfolder || "",
            type: meta.type || "output",
            mimeType: (response.headers.get("content-type") || "application/octet-stream").split(";")[0],
            sizeBytes: size,
            sha256: hash.digest("hex"),
            storagePath: dest,
            workerId: worker.id,
          };
          manifest.push(output);
          files[index] = { filename, subfolder: "", type: "output" };
        }
        value[kind] = files;
      }
    }
    // Only publish a history entry after every required output has been archived.
    db.transaction(() => {
      for (const output of manifest) db.put("outputs", output);
      const latest = db.get("jobs", job.id)!;
      latest.history = safeHistory;
      latest.archiveStatus = "COMPLETE";
      latest.archiveError = null;
      db.put("jobs", latest);
    });
    await fsp.writeFile(
      path.join(dir, "outputs_manifest.json"),
      JSON.stringify(
        manifest.map((o) => ({ ...o, storagePath: undefined })),
        null,
        2
      )
    );
  } catch (e) {
    db.transaction(() => {
      const latest = db.get("jobs", job.id)!;
      latest.archiveStatus = "FAILED";
      latest.archiveError = e instanceof Error ? e.message : "Archive failed";
      db.put("jobs", latest);
    });
    throw e;
  } finally {
    const current = db.get("jobs", job.id)!;
    await fsp.writeFile(
      path.join(dir, "job.json"),
      JSON.stringify({ ...current, leaseOwner: undefined, extraData: undefined }, null, 2)
    );
  }
}
export async function stageUploads(job: Job, worker: Worker) {
  // Inputs use unique platform filenames. They are replicated to whichever GPU
  // wins scheduling; browser-controlled subfolders and worker paths are forbidden.
  const own = getDb().list("uploads", "user_id=? AND class_id=?", [job.userId, job.classId]);
  const prompt = JSON.stringify(job.promptJson);
  for (const file of own.filter((u) => prompt.includes(u.filename))) {
    const form = new FormData();
    form.set("image", await fs.openAsBlob(file.storagePath, { type: file.mimeType }), file.filename);
    form.set("overwrite", "true");
    form.set("type", "input");
    const r = await workerFetch(worker, "/upload/image", { method: "POST", body: form }, 600000);
    if (!r.ok) throw new Error("Input transfer failed");
    const result = (await r.json()) as any;
    if (result.name !== file.filename || result.subfolder) throw new Error("Unexpected worker upload path");
  }
}
