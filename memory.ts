import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Alert, AuditEntry, Case } from "../types";
import type { AlertRepository, AuditRepository, BlobStore, CaseRepository } from "./types";

export class MemoryCaseRepository implements CaseRepository {
  private m = new Map<string, Case>();
  async get(id: string) { const c = this.m.get(id); return c ? structuredClone(c) : undefined; }
  async list() { return [...this.m.values()].map((c) => structuredClone(c)); }
  async save(c: Case) { this.m.set(c.id, structuredClone(c)); }
  clear() { this.m.clear(); }
}

export class MemoryAlertRepository implements AlertRepository {
  private m = new Map<string, Alert>();
  async get(id: string) { const a = this.m.get(id); return a ? { ...a } : undefined; }
  async list() { return [...this.m.values()].map((a) => ({ ...a })); }
  async save(a: Alert) { this.m.set(a.id, { ...a }); }
  clear() { this.m.clear(); }
}

export class MemoryAuditRepository implements AuditRepository {
  private rows: AuditEntry[] = [];
  async append(e: AuditEntry) { this.rows.push(e); }
  clear() { this.rows = []; }
  async last() { return this.rows[this.rows.length - 1]; }
  async all() { return [...this.rows]; }
  async recent(limit: number, caseId?: string) {
    const rows = caseId ? this.rows.filter((r) => r.caseId === caseId) : this.rows;
    return rows.slice(-limit);
  }
  /** Test helper: simulates someone editing stored history. */
  _tamper(index: number, patch: Partial<AuditEntry>) { this.rows[index] = { ...this.rows[index]!, ...patch }; }
}

export class MemoryBlobStore implements BlobStore {
  private m = new Map<string, Buffer>();
  async put(sha: string, bytes: Buffer) { this.m.set(sha, Buffer.from(bytes)); }
  async get(sha: string) { return this.m.get(sha); }
}

/** Content-addressed files on disk: the file name is its own SHA-256. */
export class FsBlobStore implements BlobStore {
  constructor(private dir: string) {}
  async put(sha: string, bytes: Buffer) {
    if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error("invalid digest");
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, sha), bytes, { flag: "w" });
  }
  async get(sha: string) {
    if (!/^[a-f0-9]{64}$/.test(sha)) return undefined;
    try { return await readFile(join(this.dir, sha)); } catch { return undefined; }
  }
}
