import { randomUUID } from "node:crypto";
import { getDb, closeDb } from "./index";
if (process.env.NODE_ENV === "production") throw new Error("Development seed is disabled in production");
const db = getDb(),
  now = new Date().toISOString();
db.transaction(() => {
  if (db.list("classes").length) throw new Error("Seed requires an empty database");
  db.put("users", {
    id: randomUUID(),
    email: "admin@example.edu",
    firstName: "Demo",
    lastName: "Administrator",
    emailVerifiedAt: now,
    status: "ACTIVE",
    globalRole: "ADMIN",
    lastLoginAt: null,
    createdAt: now,
  });
  const cls = db.put("classes", {
    id: randomUUID(),
    slug: "csci4300-fall-2026",
    name: "Web Programming",
    courseCode: "CSCI 4300",
    term: "Fall 2026",
    description: "Fabricated development data",
    active: true,
    signupEnabled: false,
    signupTokenVersion: 0,
    createdAt: now,
    updatedAt: now,
  });
  for (let i = 1; i <= 4; i++)
    db.put("enrollments", {
      id: randomUUID(),
      classId: cls.id,
      userId: null,
      rosterEmail: `student${i}@example.edu`,
      orgDefinedId: `10000000${i}`,
      firstName: `Student ${i}`,
      lastName: "Example",
      role: "STUDENT",
      status: "INVITED",
    });
  db.put("workers", {
    id: randomUUID(),
    name: "mock",
    baseUrl: "http://127.0.0.1:8188",
    enabled: true,
    gpuName: "Mock GPU",
    vramMb: 24576,
    architecture: "mock",
    tags: ["mock"],
    maxConcurrentJobs: 1,
    lastHealthCheck: null,
    healthStatus: "OFFLINE",
    lastAssignedAt: 0,
    externalBusy: false,
  });
});
closeDb();
console.log("Fabricated seed created. Authenticate through SMTP.");
