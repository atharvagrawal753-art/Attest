import { createHash } from "node:crypto";
import type { Clock } from "../clock";
import type { AuditRepository } from "../repositories/types";
import type { Actor, AuditAction, AuditEntry } from "../types";

export const SYSTEM_ACTOR = { id: "system", name: "System", role: "system" } as const;
const GENESIS = "0".repeat(64);

/** JSON with sorted keys, so the same data always hashes the same way. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}

const digest = (prev: string, body: unknown) => createHash("sha256").update(prev + "|" + stableStringify(body)).digest("hex");

export interface AuditVerification { valid: boolean; entries: number; brokenAtSeq?: number; reason?: string; head: string }

/** Append-only audit trail. Every entry commits to the hash of the one before it, so editing or removing
 *  any past entry breaks the chain and is detected by verify(). */
export class AuditService {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private repo: AuditRepository, private clock: Clock) {}

  record(action: AuditAction, actor: Actor | typeof SYSTEM_ACTOR, details: Record<string, unknown> = {}, caseId?: string): Promise<AuditEntry> {
    // Serialise appends so sequence numbers and hashes can never interleave.
    const run = this.tail.then(async () => {
      const prev = await this.repo.last();
      const seq = (prev?.seq ?? 0) + 1;
      const prevHash = prev?.hash ?? GENESIS;
      const body = {
        seq, ts: this.clock.now().toISOString(), caseId, action,
        actor: { id: actor.id, name: actor.name, role: actor.role }, details,
      };
      const entry: AuditEntry = { ...body, id: `aud_${seq}`, prevHash, hash: digest(prevHash, body) };
      await this.repo.append(entry);
      return entry;
    });
    this.tail = run.catch(() => undefined);
    return run;
  }

  recent(limit: number, caseId?: string) { return this.repo.recent(limit, caseId); }

  async verify(): Promise<AuditVerification> {
    const rows = await this.repo.all();
    let prevHash = GENESIS;
    for (const [i, r] of rows.entries()) {
      const { seq, ts, caseId, action, actor, details } = r;
      if (r.seq !== i + 1) return { valid: false, entries: rows.length, brokenAtSeq: r.seq, reason: "sequence gap", head: prevHash };
      if (r.prevHash !== prevHash) return { valid: false, entries: rows.length, brokenAtSeq: r.seq, reason: "previous hash mismatch", head: prevHash };
      if (digest(prevHash, { seq, ts, caseId, action, actor, details }) !== r.hash) {
        return { valid: false, entries: rows.length, brokenAtSeq: r.seq, reason: "entry content changed", head: prevHash };
      }
      prevHash = r.hash;
    }
    return { valid: true, entries: rows.length, head: prevHash };
  }
}
