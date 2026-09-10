export type Role = "ADMIN" | "STUDENT" | "INSTRUCTOR" | "TA";
export interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  /** scrypt hash. Empty for accounts created before passwords existed. */
  passwordHash: string;
  emailVerifiedAt: string | null;
  /** PENDING = password set, email not yet proven, so the account cannot sign in. */
  status: "PENDING" | "ACTIVE" | "DISABLED";
  globalRole: Role;
  lastLoginAt: string | null;
  createdAt: string;
}
export interface ClassRow {
  id: string;
  name: string;
  courseCode: string;
  term: string;
  description: string;
  slug: string;
  active: boolean;
  signupEnabled: boolean;
  signupTokenVersion: number;
  createdAt: string;
  updatedAt: string;
}
export interface Enrollment {
  id: string;
  classId: string;
  userId: string | null;
  rosterEmail: string;
  orgDefinedId: string;
  firstName: string;
  lastName: string;
  role: Role;
  status: "INVITED" | "ACTIVE" | "ARCHIVED";
}
export interface SignupToken {
  id: string;
  classId: string;
  tokenHash: string;
  version: number;
  enabled: boolean;
  createdAt: string;
}
export interface Verification {
  id: string;
  email: string;
  /** ACTIVATE proves a new address once; RESET re-sets a forgotten password. */
  purpose: "ACTIVATE" | "RESET";
  userId: string;
  classId: string | null;
  enrollmentIds: string[];
  signupVersion: number | null;
  expiresAt: number;
  consumedAt: number | null;
}
export interface Session {
  id: string;
  userId: string;
  expiresAt: number;
  classId?: string;
  enrollmentId?: string;
}
export interface WorkspaceTicket {
  id: string;
  userId: string;
  classId: string;
  enrollmentId: string;
  expiresAt: number;
  consumedAt: number | null;
}
export interface Worker {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  gpuName: string;
  vramMb: number;
  architecture: string;
  tags: string[];
  maxConcurrentJobs: number;
  lastHealthCheck: string | null;
  healthStatus: "ONLINE" | "BUSY" | "OFFLINE" | "DISABLED";
  lastAssignedAt: number;
  externalBusy: boolean;
  nodeDefinitions?: Record<string, any>;
  // Reported by the worker's /system_stats during health polling. Surfaced to the
  // workspace so its frontend can version-check nodes instead of guessing.
  comfyVersion?: string;
  pythonVersion?: string;
}
export type JobStatus = "QUEUED" | "DISPATCHING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED" | "LOST";
export interface Job {
  id: string;
  classId: string;
  userId: string;
  enrollmentId: string;
  orgDefinedId: string;
  workerId: string | null;
  comfyPromptId: string | null;
  status: JobStatus;
  archiveStatus: "PENDING" | "ARCHIVING" | "COMPLETE" | "FAILED" | "EXPIRED";
  submittedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  runtimeMs: number | null;
  promptJson: Record<string, any>;
  submittedPromptJson?: Record<string, any>;
  workflowJson: unknown;
  extraData: Record<string, unknown>;
  requiredTags: string[];
  error: string | null;
  archiveError: string | null;
  history: Record<string, any> | null;
  cancelRequested: boolean;
  leaseOwner: string | null;
}
export interface Output {
  id: string;
  jobId: string;
  fileName: string;
  originalFilename: string;
  subfolder: string;
  type: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  storagePath: string;
  workerId: string;
}
export interface Audit {
  id: string;
  type: string;
  actorId: string | null;
  classId: string | null;
  targetId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}
export interface RosterImport {
  id: string;
  classId: string;
  actorId: string;
  createdAt: string;
  status: "PREVIEW" | "COMMITTED";
  rows: any[];
  csvHash: string;
  missingIds: string[];
  summary: Record<string, number>;
}
export interface RosterImportRow {
  id: string;
  importId: string;
  line: number;
  state: string;
  row: Record<string, unknown>;
}
export interface Invitation {
  id: string;
  classId: string;
  email: string;
  actorId: string;
  createdAt: string;
  status: "SENT" | "FAILED";
  error: string | null;
}
export interface Upload {
  id: string;
  userId: string;
  classId: string;
  filename: string;
  storagePath: string;
  mimeType: string;
  createdAt: string;
}
export interface UserData {
  id: string;
  userId: string;
  classId: string;
  path: string;
  content: string;
  modified: number;
}
export interface Tables {
  users: User;
  classes: ClassRow;
  enrollments: Enrollment;
  signup_tokens: SignupToken;
  verifications: Verification;
  sessions: Session;
  gateway_sessions: Session;
  workspace_tickets: WorkspaceTicket;
  workers: Worker;
  jobs: Job;
  outputs: Output;
  audits: Audit;
  roster_imports: RosterImport;
  roster_import_rows: RosterImportRow;
  invitations: Invitation;
  uploads: Upload;
  user_data: UserData;
}
