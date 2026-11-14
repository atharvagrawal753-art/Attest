import { createHash } from "node:crypto";
import type {
  AuthenticitySignal, Case, CaseDocument, DocType, FieldRow, FieldStatus, RuleOutcome, RuleResult, ScrutinyReport,
} from "../types";
import { COLUMNS, DOC_LABEL, FIELDS, MANDATORY_DOCUMENTS, type FieldDef } from "./checklist";

export interface ScrutinyOptions {
  minFaculty: number;
  /** Share of a rule's weight earned by a "Review" result. */
  reviewCredit: number;
  now: Date;
  /** Optional lookup of stored file bytes, used to re-verify hashes. */
  readBlob?: (sha256: string) => Buffer | undefined;
}

interface Reading { docType: DocType; raw: string | number; page?: number }

const norm = (v: string | number) => (typeof v === "number" ? String(v) : v.trim().toLowerCase().replace(/\s+/g, " "));
const find = (c: Case, t: DocType) => c.documents.find((d) => d.type === t);
const show = (v: string | number | null | undefined) => (v === null || v === undefined || v === "" ? "–" : String(v));

function readings(c: Case, f: FieldDef): Reading[] {
  const out: Reading[] = [];
  for (const t of COLUMNS) {
    const ev = find(c, t)?.extracted[f.key];
    if (ev && ev.value !== null && ev.value !== "") out.push({ docType: t, raw: ev.value, page: ev.page });
  }
  return out;
}

const distinct = (r: Reading[]) => new Set(r.map((x) => norm(x.raw))).size;

function fieldRow(c: Case, f: FieldDef): FieldRow {
  const cells = COLUMNS.map((t) => show(find(c, t)?.extracted[f.key]?.value)) as FieldRow["cells"];
  const status: FieldStatus = distinct(readings(c, f)) > 1 ? "bad" : "ok";
  return { key: f.key, label: f.label, cells, status };
}

function mandatoryRows(c: Case): FieldRow[] {
  return MANDATORY_DOCUMENTS.map((m) => {
    const attached = !!find(c, m.type);
    return {
      key: m.type,
      label: m.label,
      cells: ["Required", "–", attached ? "Attached" : "Not attached"] as FieldRow["cells"],
      status: (attached ? "ok" : "miss") as FieldStatus,
    };
  });
}

const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

function conflictSentence(f: FieldDef, r: Reading[]) {
  const parts = r.map((x) => `${show(x.raw)} on the ${DOC_LABEL[x.docType]}${x.page ? ` (page ${x.page})` : ""}`);
  return `${f.label.toLowerCase()} read as ${list(parts)}.`;
}

/** Each rule is data plus a pure function, so the rule set can be configured or extended. */
interface Rule { id: string; title: string; weight: number; run(c: Case, o: ScrutinyOptions): { result: RuleResult; evidence?: string } }

const field = (k: string) => FIELDS.find((f) => f.key === k)!;

const RULES: Rule[] = [
  {
    id: "NAME_MATCH", title: "Name matches across documents", weight: 30,
    run(c) {
      const r = readings(c, field("institute_name"));
      if (r.length === 0) return { result: "Missing", evidence: "No institute name could be read." };
      return distinct(r) === 1 ? { result: "Pass" } : { result: "Review", evidence: conflictSentence(field("institute_name"), r) };
    },
  },
  {
    id: "FACULTY_MINIMUM", title: "Faculty count meets minimum", weight: 30,
    run(c, o) {
      const f = field("faculty_strength"), r = readings(c, f);
      if (r.length === 0) return { result: "Missing", evidence: "No faculty strength could be read." };
      if (distinct(r) > 1) return { result: "Review", evidence: conflictSentence(f, r) };
      const n = Number(r[0]!.raw);
      return n >= o.minFaculty ? { result: "Pass" } : { result: "Review", evidence: `Faculty strength ${n} is below the configured minimum of ${o.minFaculty}.` };
    },
  },
  {
    id: "ROOM_CONSISTENCY", title: "Room count is consistent", weight: 20,
    run(c) {
      const f = field("lecture_rooms"), r = readings(c, f);
      if (r.length === 0) return { result: "Missing", evidence: "No room count could be read." };
      return distinct(r) === 1 ? { result: "Pass" } : { result: "Review", evidence: conflictSentence(f, r) };
    },
  },
  {
    id: "MANDATORY_DOCS", title: "Mandatory documents attached", weight: 20,
    run(c) {
      const missing = MANDATORY_DOCUMENTS.filter((m) => !find(c, m.type));
      return missing.length === 0
        ? { result: "Pass" }
        : { result: "Missing", evidence: `${list(missing.map((m) => m.label))} ${missing.length > 1 ? "are" : "is"} required by the checklist but not attached.` };
    },
  },
];

const CREDIT = (r: RuleResult, reviewCredit: number) => (r === "Pass" ? 1 : r === "Review" ? reviewCredit : 0);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function authenticity(c: Case, o: ScrutinyOptions): AuthenticitySignal[] {
  const out: AuthenticitySignal[] = [];
  for (const d of c.documents) {
    if (d.expiresAt && new Date(d.expiresAt) < o.now) {
      out.push({ code: "DOCUMENT_EXPIRED", documentId: d.id, message: `${DOC_LABEL[d.type]} expired on ${d.expiresAt.slice(0, 10)}.` });
    }
    const bytes = o.readBlob?.(d.sha256);
    if (bytes && createHash("sha256").update(bytes).digest("hex") !== d.sha256) {
      out.push({ code: "HASH_MISMATCH", documentId: d.id, message: `Stored file for ${DOC_LABEL[d.type]} no longer matches its recorded SHA-256.` });
    }
  }
  return out;
}

export function evaluateCase(c: Case, o: ScrutinyOptions): ScrutinyReport {
  const fields = [...FIELDS.map((f) => fieldRow(c, f)), ...mandatoryRows(c)];
  const rules: RuleOutcome[] = RULES.map((r) => ({ id: r.id, title: r.title, weight: r.weight, ...r.run(c, o) }));
  const total = rules.reduce((s, r) => s + r.weight, 0);
  const earned = rules.reduce((s, r) => s + r.weight * CREDIT(r.result, o.reviewCredit), 0);
  const score = Math.round((earned / total) * 100);

  const conflicts = fields.filter((f) => f.status === "bad").length;
  const missing = fields.filter((f) => f.status === "miss").length;
  const passed = rules.filter((r) => r.result === "Pass").length;
  const summary = `${passed} passed, ${plural(conflicts, "conflict")}, ${missing} missing`;

  const sentences = [
    ...FIELDS.filter((f) => distinct(readings(c, f)) > 1).map((f) => conflictSentence(f, readings(c, f))),
    ...rules.filter((r) => r.id === "MANDATORY_DOCS" && r.evidence).map((r) => r.evidence!),
  ];
  const evidence = sentences.length
    ? `Evidence: ${sentences.join(" ")}`
    : "Evidence: all documents agree and every mandatory document is attached.";

  return {
    caseId: c.id,
    generatedAt: o.now.toISOString(),
    fields, rules, score, summary, evidence,
    blockers: MANDATORY_DOCUMENTS.filter((m) => !find(c, m.type)),
    authenticity: authenticity(c, o),
  };
}

export function documentDigest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
export type { CaseDocument };
