import { addDays, type Clock } from "./clock";
import type { CaseRepository } from "./repositories/types";
import type { Case, CaseDocument, CaseState, DocType, ExtractedValue } from "./types";
import { AuditService } from "./services/audit";

const INTAKE = { id: "portal", name: "Institution portal", role: "institution" } as const;
const ev = (value: string | number, page: number): ExtractedValue => ({ value, page });
let n = 0;
const doc = (type: DocType, at: Date, extracted: Record<string, ExtractedValue> = {}, expiresAt?: Date): CaseDocument => ({
  id: `doc_seed${++n}`, type, filename: `${type}.pdf`, mimeType: "application/pdf", size: 120_000 + n * 997,
  sha256: String(n).padStart(64, "0"), uploadedAt: at.toISOString(), extracted, expiresAt: expiresAt?.toISOString(),
});

/** Synthetic demonstration data. Application 4839 is the sample the console scrutinises. */
export async function seed(cases: CaseRepository, audit: AuditService, clock: Clock): Promise<void> {
  const now = clock.now();
  const mk = (num: string, name: string, state: CaseState, enteredDaysAgo: number, docs: CaseDocument[]): Case => ({
    id: `AICTE-2026-${num}`, number: num, institution: { id: `inst-${num}`, name }, state,
    stateEnteredAt: addDays(now, -enteredDaysAgo).toISOString(), submittedAt: addDays(now, -enteredDaysAgo - 1).toISOString(),
    documents: docs, version: 1,
  });

  const t = addDays(now, -2);
  const sample = mk("4839", "Sample Institute of Technology", "SUBMITTED", 0.2, [
    doc("application_form", t, { institute_name: ev("Sample Institute of Technology", 1), faculty_strength: ev(64, 3), lecture_rooms: ev(42, 2) }),
    doc("faculty_certificate", t, { institute_name: ev("Sample Institute of Technology", 1), faculty_strength: ev(64, 1), faculty_qualification: ev("Ph.D., CS", 2) }, addDays(now, 400)),
    doc("infrastructure_report", t, { institute_name: ev("Sample Institute of Technology", 1), faculty_strength: ev(64, 2), lecture_rooms: ev(38, 1) }),
  ]);

  const full = (name: string, at: Date, fireExpires: Date) => [
    doc("application_form", at, { institute_name: ev(name, 1), faculty_strength: ev(72, 2), lecture_rooms: ev(30, 2) }),
    doc("faculty_certificate", at, { institute_name: ev(name, 1), faculty_strength: ev(72, 1), faculty_qualification: ev("M.Tech", 1) }, addDays(now, 300)),
    doc("infrastructure_report", at, { institute_name: ev(name, 1), faculty_strength: ev(72, 1), lecture_rooms: ev(30, 1) }),
    doc("fire_safety_certificate", at, {}, fireExpires),
  ];

  // Overdue review (21 day timeline, entered 30 days ago) with a certificate about to expire.
  const overdue = mk("4712", "Greenfield College of Engineering", "EXPERT_REVIEW", 30, full("Greenfield College of Engineering", addDays(now, -35), addDays(now, 12)));
  // Approved institution whose fire safety certificate has already lapsed.
  const lapsed = mk("4755", "Lakeview Institute of Management", "MONITORING", 120, full("Lakeview Institute of Management", addDays(now, -130), addDays(now, -5)));

  for (const c of [sample, overdue, lapsed]) {
    await cases.save(c);
    await audit.record("CASE_RECEIVED", INTAKE, { institution: c.institution.name }, c.id);
    for (const d of c.documents) await audit.record("DOCUMENT_UPLOADED", INTAKE, { type: d.type, documentId: d.id, sha256: d.sha256, size: d.size }, c.id);
  }
}
