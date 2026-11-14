export type Role = "institution" | "scrutiny_officer" | "reviewer" | "competent_authority" | "admin";

export interface Actor {
  id: string;
  name: string;
  role: Role;
  /** Set for institution users so they can only see their own applications. */
  institutionId?: string;
}

export type DocType = "application_form" | "faculty_certificate" | "infrastructure_report" | "fire_safety_certificate";

export interface ExtractedValue { value: string | number | null; page?: number }

export interface CaseDocument {
  id: string;
  type: DocType;
  filename: string;
  mimeType: string;
  size: number;
  sha256: string;
  uploadedAt: string;
  expiresAt?: string;
  /** Field key -> value read from the document (and the page it was read from). */
  extracted: Record<string, ExtractedValue>;
}

export type CaseState =
  | "SUBMITTED" | "SCRUTINY" | "EXPERT_REVIEW" | "CORRECTION_REQUESTED" | "REJECTED" | "MONITORING";

export type DecisionLabel = "Approved" | "Correction requested" | "Rejected";

export interface DecisionRecord {
  decision: DecisionLabel;
  reason: string;
  override: boolean;
  actor: Actor;
  at: string;
}

export type FieldStatus = "ok" | "bad" | "miss";
export type RuleResult = "Pass" | "Review" | "Missing";

export interface FieldRow { key: string; label: string; cells: [string, string, string]; status: FieldStatus }
export interface RuleOutcome { id: string; title: string; result: RuleResult; weight: number; evidence?: string }

export interface AuthenticitySignal {
  code: "DOCUMENT_EXPIRED" | "HASH_MISMATCH";
  documentId: string;
  message: string;
}

export interface ScrutinyReport {
  caseId: string;
  generatedAt: string;
  fields: FieldRow[];
  rules: RuleOutcome[];
  score: number;
  summary: string;
  evidence: string;
  /** Mandatory documents that are still missing. A non-empty list blocks approval. */
  blockers: { type: DocType; label: string }[];
  /** Warnings for a person to examine. They are not findings of fraud. */
  authenticity: AuthenticitySignal[];
}

export interface Case {
  id: string;
  number: string;
  institution: { id: string; name: string };
  state: CaseState;
  stateEnteredAt: string;
  submittedAt: string;
  documents: CaseDocument[];
  lastReport?: ScrutinyReport;
  decision?: DecisionRecord;
  version: number;
}

export type AlertKind = "STAGE_DUE_SOON" | "STAGE_OVERDUE" | "CERTIFICATE_EXPIRING" | "COMPLIANCE_LAPSE";
export type Severity = "low" | "medium" | "high" | "critical";
export type AlertStatus = "open" | "acknowledged" | "resolved";

export interface Alert {
  id: string;
  caseId: string;
  kind: AlertKind;
  severity: Severity;
  message: string;
  status: AlertStatus;
  /** Escalation level: 1 = scrutiny officer, rising while nobody acts. */
  level: number;
  assignedTo: string;
  occurredAt: string;
  lastEscalatedAt: string;
  acknowledgedBy?: string;
  acknowledgedAt?: string;
  resolvedAt?: string;
  dedupeKey: string;
}

export type AuditAction =
  | "CASE_RECEIVED" | "DOCUMENT_UPLOADED" | "STATE_CHANGED" | "SCRUTINY_COMPLETED"
  | "DECISION_RECORDED" | "OVERRIDE_RECORDED" | "ALERT_RAISED" | "ALERT_ESCALATED"
  | "ALERT_ACKNOWLEDGED" | "ALERT_RESOLVED";

export interface AuditEntry {
  seq: number;
  id: string;
  ts: string;
  caseId?: string;
  action: AuditAction;
  actor: { id: string; name: string; role: string };
  details: Record<string, unknown>;
  prevHash: string;
  hash: string;
}
