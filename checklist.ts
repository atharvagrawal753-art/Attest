import type { DocType } from "../types";

/** Column order of the scrutiny table in the console. */
export const COLUMNS: DocType[] = ["application_form", "faculty_certificate", "infrastructure_report"];

export const DOC_LABEL: Record<DocType, string> = {
  application_form: "application form",
  faculty_certificate: "faculty certificate",
  infrastructure_report: "infrastructure report",
  fire_safety_certificate: "fire safety certificate",
};

export interface FieldDef { key: string; label: string; kind: "text" | "number" }

/** Fields compared across documents. Extend this list to add checks without touching the engine. */
export const FIELDS: FieldDef[] = [
  { key: "institute_name", label: "Institute name", kind: "text" },
  { key: "faculty_strength", label: "Faculty strength", kind: "number" },
  { key: "faculty_qualification", label: "Faculty qualification", kind: "text" },
  { key: "lecture_rooms", label: "Lecture rooms", kind: "number" },
];

export const MANDATORY_DOCUMENTS: { type: DocType; label: string }[] = [
  { type: "fire_safety_certificate", label: "Fire safety certificate" },
];

/** Documents that carry an expiry date and are watched by the alert engine. */
export const EXPIRING_DOCUMENTS: DocType[] = ["fire_safety_certificate", "faculty_certificate"];
