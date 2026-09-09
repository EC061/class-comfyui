import { getPool } from "./index.js";
import { DDL } from "./ddl-inline.js";
import { createHash, randomBytes } from "node:crypto";

function hash(t: string) {
  return createHash("sha256").update(t).digest("hex");
}

// Dev seed with fabricated identities only.
async function seed() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL required");
  const pool = getPool(url);
  await pool.query(DDL);
  const adminEmail = "admin@example.edu";
  await pool.query(
    `INSERT INTO users (email, first_name, last_name, email_verified_at, status, global_role)
     VALUES ($1,'Admin','User', NOW(), 'ACTIVE','ADMIN')
     ON CONFLICT (email) DO UPDATE SET global_role='ADMIN', status='ACTIVE'`,
    [adminEmail]
  );
  const { rows: cls } = await pool.query(
    `INSERT INTO classes (name, course_code, term, description, slug, active, signup_enabled)
     VALUES ('Web Programming','CSCI 4300','Fall 2026','Seed class','csci4300-fall-2026', TRUE, TRUE)
     ON CONFLICT (slug) DO UPDATE SET active=TRUE RETURNING id`
  );
  const classId = cls[0]?.id ?? (await pool.query(`SELECT id FROM classes WHERE slug='csci4300-fall-2026'`)).rows[0].id;
  const students = [
    ["100000001", "Garcia", "Amara", "student1@example.edu"],
    ["100000002", "Chen", "Liam", "student2@example.edu"],
    ["100000003", "Okafor", "Maya", "student3@example.edu"],
    ["100000004", "Patel", "Ravi", "student4@example.edu"],
  ];
  for (const [orgId, last, first, email] of students) {
    await pool.query(
      `INSERT INTO class_enrollments (class_id, roster_email, org_defined_id, first_name, last_name, role, status)
       VALUES ($1,$2,$3,$4,$5,'STUDENT','INVITED')
       ON CONFLICT (class_id, roster_email) DO UPDATE SET org_defined_id=$3, first_name=$4, last_name=$5`,
      [classId, email, orgId, first, last]
    );
  }
  // signup token (dev only, printed once)
  const raw = randomBytes(24).toString("base64url");
  await pool.query(`UPDATE classes SET signup_token_version = signup_token_version + 1 WHERE id=$1`, [classId]);
  const { rows: c2 } = await pool.query(`SELECT signup_token_version FROM classes WHERE id=$1`, [classId]);
  await pool.query(`UPDATE class_signup_tokens SET enabled=FALSE, revoked_at=NOW() WHERE class_id=$1`, [classId]);
  await pool.query(`INSERT INTO class_signup_tokens (class_id, token_hash, version, enabled) VALUES ($1,$2,$3,TRUE)`, [
    classId,
    hash(raw),
    c2[0].signup_token_version,
  ]);
  await pool.query(
    `INSERT INTO workers (name, base_url, enabled, gpu_name, vram_mb, max_concurrent_jobs, health_status, tags)
     VALUES ('mock-4090','http://mock-comfy:8188', TRUE, 'Mock RTX 4090', 24576, 1, 'OFFLINE', '["4090","24gb"]'::jsonb)
     ON CONFLICT (name) DO NOTHING`
  );
  console.log(`Seed complete. Dev signup token (NOT for production): ${raw}`);
  await pool.end();
}

seed().catch((e) => {
  console.error(e);
  process.exit(1);
});
