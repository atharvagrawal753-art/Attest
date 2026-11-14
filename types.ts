import type { Alert, AuditEntry, Case } from "../types";

/** Persistence ports. The in-memory adapters below can be replaced by PostgreSQL/MongoDB adapters
 *  without touching services or routes. */
export interface CaseRepository {
  get(id: string): Promise<Case | undefined>;
  list(): Promise<Case[]>;
  save(c: Case): Promise<void>;
}

export interface AlertRepository {
  get(id: string): Promise<Alert | undefined>;
  list(): Promise<Alert[]>;
  save(a: Alert): Promise<void>;
}

export interface AuditRepository {
  append(e: AuditEntry): Promise<void>;
  last(): Promise<AuditEntry | undefined>;
  all(): Promise<AuditEntry[]>;
  /** Most recent `limit` entries, oldest first. */
  recent(limit: number, caseId?: string): Promise<AuditEntry[]>;
}

export interface BlobStore {
  put(sha256: string, bytes: Buffer): Promise<void>;
  get(sha256: string): Promise<Buffer | undefined>;
}
