import express from "express";
import { randomUUID } from "node:crypto";
import { getDb, activeMembership, type Session, type UserData } from "@class-comfyui/database";
// Internal rows that live in the same table as the student's files but are not
// files: the settings blob and the starter-seeding marker.
const RESERVED = ["__settings__", "__starters__"];
function reserved(p: string) {
  return RESERVED.includes(p);
}
function validPath(p: string) {
  return (
    p.length > 0 &&
    p.length <= 500 &&
    !p.startsWith("/") &&
    !p.includes("\\") &&
    !Array.from(p).some((c) => c.charCodeAt(0) < 32) &&
    !p.split("/").some((v) => !v || v === "." || v === "..")
  );
}
function files(s: Session) {
  return getDb().list("user_data", "user_id=? AND class_id=?", [s.userId, s.classId!]);
}
function info(v: UserData, p = v.path) {
  return { path: p, size: Buffer.byteLength(v.content), modified: v.modified, created: v.modified };
}
export function saveUserData(s: Session, p: string, content: string) {
  return getDb().transaction(() => {
    const db = getDb();
    if (!activeMembership(db, s.userId, s.classId!, s.enrollmentId)) throw new Error("Access revoked");
    const rows = files(s);
    if (
      rows.filter((v) => v.path !== p).reduce((n, v) => n + Buffer.byteLength(v.content), 0) +
        Buffer.byteLength(content) >
      50 * 1024 * 1024
    )
      throw new Error("User data quota exceeded");
    return db.put("user_data", {
      id: rows.find((v) => v.path === p)?.id || randomUUID(),
      userId: s.userId,
      classId: s.classId!,
      path: p,
      content,
      modified: Date.now(),
    });
  });
}
export function installUserData(app: express.Express) {
  app.get("/userdata", (req, res) => {
    const dir = String(req.query.dir || "").replace(/\/$/, "");
    if (dir && !validPath(dir)) {
      res.status(400).json({ error: "Invalid directory" });
      return;
    }
    const prefix = dir ? dir + "/" : "";
    const results = files(res.locals.session)
      .filter((v) => !reserved(v.path) && v.path.startsWith(prefix))
      .map((v) => ({ row: v, relative: v.path.slice(prefix.length) }))
      .filter((v) => req.query.recurse === "true" || !v.relative.includes("/"));
    res.json(
      results.map(({ row, relative }) =>
        req.query.full_info === "true"
          ? info(row, relative)
          : req.query.split === "true"
            ? [relative, ...relative.split("/")]
            : relative
      )
    );
  });
  app.get("/v2/userdata", (req, res) => {
    const dir = String(req.query.path || "").replace(/\/$/, "");
    if (dir && !validPath(dir)) {
      res.status(400).json({ error: "Invalid directory" });
      return;
    }
    const prefix = dir ? dir + "/" : "",
      directories = new Set<string>(),
      result: Record<string, unknown>[] = [];
    for (const row of files(res.locals.session).filter((v) => !reserved(v.path) && v.path.startsWith(prefix))) {
      const pieces = row.path.split("/");
      for (let i = 1; i < pieces.length; i++) {
        const folder = pieces.slice(0, i).join("/");
        if (folder !== dir && folder.startsWith(prefix)) directories.add(folder);
      }
      result.push({ name: pieces.at(-1), type: "file", ...info(row), modified: row.modified / 1000 });
    }
    for (const folder of directories) result.push({ name: folder.split("/").at(-1), path: folder, type: "directory" });
    res.json(
      result.sort(
        (a, b) => Number(a.type === "file") - Number(b.type === "file") || String(a.path).localeCompare(String(b.path))
      )
    );
  });
  app.post("/userdata/:source/move/:dest", (req, res) => {
    const s = res.locals.session as Session,
      { source, dest } = req.params;
    if (!validPath(source) || !validPath(dest) || reserved(source) || reserved(dest)) {
      res.status(400).json({ error: "Invalid path" });
      return;
    }
    getDb().transaction(() => {
      const rows = files(s),
        from = rows.find((v) => v.path === source),
        to = rows.find((v) => v.path === dest);
      if (!from) {
        res.status(404).end();
        return;
      }
      if (to && req.query.overwrite === "false") {
        res.status(409).json({ error: "Destination exists" });
        return;
      }
      if (to && to.id !== from.id) getDb().delete("user_data", to.id);
      from.path = dest;
      from.modified = Date.now();
      getDb().put("user_data", from);
      res.json(req.query.full_info === "true" ? info(from) : dest);
    });
  });
  app.all("/userdata/*", express.text({ type: "*/*", limit: "5mb" }), (req, res) => {
    const s = res.locals.session as Session,
      p = String((req.params as Record<string, string>)[0]);
    if (!validPath(p) || reserved(p)) {
      res.status(400).json({ error: "Invalid path" });
      return;
    }
    getDb().transaction(() => {
      const existing = files(s).find((v) => v.path === p);
      if (req.method === "GET") {
        if (!existing) {
          res.status(404).end();
          return;
        }
        res.setHeader("Content-Disposition", "attachment");
        res.type("application/json").send(existing.content);
        return;
      }
      if (req.method === "DELETE") {
        if (existing) getDb().delete("user_data", existing.id);
        res.status(204).end();
        return;
      }
      if (req.method === "POST") {
        if (existing && req.query.overwrite === "false") {
          res.status(409).json({ error: "File already exists" });
          return;
        }
        const saved = saveUserData(s, p, typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {}));
        res.json(req.query.full_info === "true" ? info(saved) : p);
        return;
      }
      res.status(405).end();
    });
  });
}
