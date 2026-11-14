import { randomUUID } from "node:crypto";
import type { Clock } from "../clock";
import { addDays } from "../clock";
import type { Config } from "../config";
import { AppError } from "../errors";
import { evaluateCase, documentDigest } from "../domain/scrutiny";
import { STATE_LABEL, transition, type WorkflowEvent } from "../domain/workflow";
import type { BlobStore, CaseRepository } from "../repositories/types";
import type { Actor, Case, CaseDocument, DecisionLabel, DocType, ExtractedValue, ScrutinyReport } from "../types";
import { AuditService } from "./audit";
import { assertCan, can } from "./permissions";

export const REVIEW_CREDIT = 0.6;
const ALLOWED_MIME: Record<string, (b: Buffer) => boolean> = {
  "application/pdf": (b) => b.subarray(0, 5).toString("latin1") === "%PDF-",
  "image/png": (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
};

export interface UploadInput {
  type: DocType;
  filename: string;
  mimeType: string;
  contentBase64: string;
  expiresAt?: string;
  /** Values read from the document. Supplied by the extraction provider or the officer. */
  declaredFields?: Record<string, ExtractedValue>;
}

const EVENT_FOR: Record<DecisionLabel, WorkflowEvent> = {
  Approved: "APPROVE", Rejected: "REJECT", "Correction requested": "REQUEST_CORRECTION",
};

export class CaseService {
  constructor(
    private cases: CaseRepository,
    private audit: AuditService,
    private blobs: BlobStore,
    private clock: Clock,
    private cfg: Pick<Config, "minFaculty" | "slaDays" | "maxUploadBytes">,
  ) {}

  private async load(id: string, actor?: Actor): Promise<Case> {
    const c = await this.cases.get(id);
    // Institution users see only their own applications; to them others do not exist.
    if (!c || (actor?.role === "institution" && actor.institutionId !== c.institution.id)) throw AppError.notFound("Application");
    return c;
  }

  private report(c: Case): ScrutinyReport {
    return evaluateCase(c, { minFaculty: this.cfg.minFaculty, reviewCredit: REVIEW_CREDIT, now: this.clock.now() });
  }

  private async move(c: Case, event: WorkflowEvent, actor: Actor, reason: string) {
    const from = c.state;
    c.state = transition(from, event);
    c.stateEnteredAt = this.clock.now().toISOString();
    c.version++;
    await this.audit.record("STATE_CHANGED", actor, { from, to: c.state, reason }, c.id);
  }

  deadlineOf(c: Case): string | undefined {
    const days = (this.cfg.slaDays as Record<string, number | undefined>)[c.state];
    return days ? addDays(new Date(c.stateEnteredAt), days).toISOString() : undefined;
  }

  view(c: Case) {
    return {
      id: c.id, number: c.number, institution: c.institution, state: c.state, stateLabel: STATE_LABEL[c.state],
      stateEnteredAt: c.stateEnteredAt, deadlineAt: this.deadlineOf(c), submittedAt: c.submittedAt,
      decision: c.decision ? { decision: c.decision.decision, reason: c.decision.reason, override: c.decision.override, by: c.decision.actor.name, at: c.decision.at } : undefined,
      documents: c.documents.map(({ extracted: _e, ...d }) => d),
    };
  }

  async list(actor: Actor) {
    assertCan(actor, "case:read");
    const all = await this.cases.list();
    return all
      .filter((c) => actor.role !== "institution" || c.institution.id === actor.institutionId)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((c) => this.view(c));
  }

  async get(id: string, actor: Actor) {
    assertCan(actor, "case:read");
    return this.view(await this.load(id, actor));
  }

  /** Read-only comparison. Nothing is stored and nothing is written to the audit trail. */
  async preview(id: string, actor: Actor) {
    assertCan(actor, "case:read");
    return this.report(await this.load(id, actor));
  }

  async latestReport(id: string, actor: Actor) {
    assertCan(actor, "case:read");
    const c = await this.load(id, actor);
    if (!c.lastReport) throw AppError.notFound("Scrutiny report");
    return c.lastReport;
  }

  async runScrutiny(id: string, actor: Actor) {
    assertCan(actor, "case:scrutiny");
    return this.scrutinise(await this.load(id, actor), actor);
  }

  private async scrutinise(c: Case, actor: Actor): Promise<ScrutinyReport> {
    if (!["SUBMITTED", "SCRUTINY", "EXPERT_REVIEW"].includes(c.state)) {
      throw AppError.conflict("INVALID_STATE", `Application is ${STATE_LABEL[c.state]}; scrutiny cannot be run`);
    }
    if (c.state === "SUBMITTED") await this.move(c, "START_SCRUTINY", actor, "Scrutiny started");
    const report = await this.withHashChecks(c);
    c.lastReport = report;
    if (c.state === "SCRUTINY") await this.move(c, "COMPLETE_SCRUTINY", actor, "Moved to expert review");
    c.version++;
    await this.cases.save(c);
    await this.audit.record("SCRUTINY_COMPLETED", actor, {
      score: report.score, summary: report.summary, blockers: report.blockers.map((b) => b.type),
      authenticitySignals: report.authenticity.length,
    }, c.id);
    return report;
  }

  private async withHashChecks(c: Case): Promise<ScrutinyReport> {
    const blobs = new Map<string, Buffer>();
    for (const d of c.documents) { const b = await this.blobs.get(d.sha256); if (b) blobs.set(d.sha256, b); }
    return evaluateCase(c, { minFaculty: this.cfg.minFaculty, reviewCredit: REVIEW_CREDIT, now: this.clock.now(), readBlob: (h) => blobs.get(h) });
  }

  async decide(id: string, actor: Actor, input: { decision: DecisionLabel; reason: string; override?: boolean }) {
    assertCan(actor, "case:decide");
    const c = await this.load(id, actor);
    if (["SUBMITTED", "SCRUTINY"].includes(c.state)) await this.scrutinise(c, actor);
    if (c.state !== "EXPERT_REVIEW") {
      throw AppError.conflict("INVALID_STATE", `Application is ${STATE_LABEL[c.state]}; a decision cannot be recorded`);
    }

    // Recheck at the moment of decision, never trust an older report.
    const report = await this.withHashChecks(c);
    let overridden = false;
    if (input.decision === "Approved" && report.blockers.length > 0) {
      const names = report.blockers.map((b) => b.label).join(", ");
      if (!input.override) {
        throw AppError.conflict("MANDATORY_DOCUMENT_MISSING",
          `Approval blocked: mandatory document missing (${names}). An authorised officer may record an override.`,
          { blockers: report.blockers });
      }
      if (!can(actor, "case:override")) {
        throw AppError.forbidden("Only a competent authority can override a missing mandatory document");
      }
      if (input.reason.trim().length < 20) {
        throw AppError.validation("An override needs a written reason of at least 20 characters");
      }
      overridden = true;
      await this.audit.record("OVERRIDE_RECORDED", actor, { blockers: report.blockers.map((b) => b.type), reason: input.reason }, c.id);
    }

    const at = this.clock.now().toISOString();
    c.lastReport = report;
    c.decision = { decision: input.decision, reason: input.reason, override: overridden, actor, at };
    await this.audit.record("DECISION_RECORDED", actor, { decision: input.decision, reason: input.reason, override: overridden, score: report.score }, c.id);
    await this.move(c, EVENT_FOR[input.decision], actor, `${input.decision} by ${actor.name}`);
    await this.cases.save(c);
    return {
      message: `${input.decision}${overridden ? " (override recorded)" : ""} – Application ${c.number}`,
      state: c.state, decision: this.view(c).decision,
    };
  }

  async resubmit(id: string, actor: Actor) {
    assertCan(actor, "case:resubmit");
    const c = await this.load(id, actor);
    await this.move(c, "RESUBMIT", actor, "Resubmitted by institution");
    await this.cases.save(c);
    return this.view(c);
  }

  async addDocument(id: string, actor: Actor, input: UploadInput) {
    assertCan(actor, "case:upload");
    const c = await this.load(id, actor);
    if (!["SUBMITTED", "CORRECTION_REQUESTED"].includes(c.state)) {
      throw AppError.conflict("INVALID_STATE", `Application is ${STATE_LABEL[c.state]}; documents can no longer be changed`);
    }
    const check = ALLOWED_MIME[input.mimeType];
    if (!check) throw new AppError(415, "UNSUPPORTED_MEDIA", "Only PDF, JPG and PNG files are accepted");
    const bytes = Buffer.from(input.contentBase64, "base64");
    if (bytes.length === 0) throw AppError.validation("The file is empty");
    if (bytes.length > this.cfg.maxUploadBytes) throw new AppError(413, "PAYLOAD_TOO_LARGE", `File exceeds ${Math.floor(this.cfg.maxUploadBytes / 1024 / 1024)} MB`);
    if (!check(bytes)) throw new AppError(415, "UNSUPPORTED_MEDIA", "File content does not match its declared type");

    const sha256 = documentDigest(bytes);
    await this.blobs.put(sha256, bytes);
    const prior = c.documents.find((d) => d.type === input.type);
    const doc: CaseDocument = {
      id: `doc_${randomUUID().slice(0, 8)}`, type: input.type, filename: input.filename.slice(0, 200), mimeType: input.mimeType,
      size: bytes.length, sha256, uploadedAt: this.clock.now().toISOString(), expiresAt: input.expiresAt,
      extracted: input.declaredFields ?? {},
    };
    c.documents = [...c.documents.filter((d) => d.type !== input.type), doc];
    c.version++;
    await this.cases.save(c);
    await this.audit.record("DOCUMENT_UPLOADED", actor, { type: input.type, documentId: doc.id, sha256, size: doc.size, replacedSha256: prior?.sha256 }, c.id);
    const { extracted: _e, ...meta } = doc;
    return meta;
  }

  /** Used by the alert engine. Read-only snapshot of every case. */
  all() { return this.cases.list(); }
}
