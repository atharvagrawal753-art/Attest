import type { CaseState } from "../types";
import { AppError } from "../errors";

export type WorkflowEvent =
  | "START_SCRUTINY" | "COMPLETE_SCRUTINY" | "APPROVE" | "REJECT" | "REQUEST_CORRECTION" | "RESUBMIT";

/** The only legal moves between stages. Anything else is rejected with 409. */
const TRANSITIONS: Record<CaseState, Partial<Record<WorkflowEvent, CaseState>>> = {
  SUBMITTED: { START_SCRUTINY: "SCRUTINY" },
  SCRUTINY: { COMPLETE_SCRUTINY: "EXPERT_REVIEW" },
  EXPERT_REVIEW: { APPROVE: "MONITORING", REJECT: "REJECTED", REQUEST_CORRECTION: "CORRECTION_REQUESTED" },
  CORRECTION_REQUESTED: { RESUBMIT: "SUBMITTED" },
  REJECTED: {},
  MONITORING: {},
};

export const STATE_LABEL: Record<CaseState, string> = {
  SUBMITTED: "submitted",
  SCRUTINY: "under scrutiny",
  EXPERT_REVIEW: "in expert review",
  CORRECTION_REQUESTED: "awaiting corrections from the institution",
  REJECTED: "rejected",
  MONITORING: "approved and under compliance monitoring",
};

/** States that run against a statutory timeline. */
export const TIMED_STATES = ["SUBMITTED", "SCRUTINY", "EXPERT_REVIEW", "CORRECTION_REQUESTED"] as const;
export type TimedState = (typeof TIMED_STATES)[number];
export const isTimed = (s: CaseState): s is TimedState => (TIMED_STATES as readonly string[]).includes(s);

export function canTransition(from: CaseState, event: WorkflowEvent): boolean {
  return TRANSITIONS[from][event] !== undefined;
}

export function transition(from: CaseState, event: WorkflowEvent): CaseState {
  const to = TRANSITIONS[from][event];
  if (!to) {
    throw AppError.conflict("INVALID_STATE", `Application is ${STATE_LABEL[from]}; ${event.toLowerCase().replace(/_/g, " ")} is not allowed`);
  }
  return to;
}
