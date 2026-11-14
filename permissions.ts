import { AppError } from "../errors";
import type { Actor, Role } from "../types";

export type Permission =
  | "case:read" | "case:upload" | "case:resubmit" | "case:scrutiny" | "case:decide" | "case:override"
  | "alert:read" | "alert:ack" | "audit:read" | "demo:reset";

const READ: Permission[] = ["case:read", "alert:read", "audit:read"];

const MATRIX: Record<Role, Permission[]> = {
  institution: ["case:read", "case:upload", "case:resubmit"],
  scrutiny_officer: [...READ, "case:scrutiny", "alert:ack"],
  reviewer: [...READ, "case:scrutiny", "case:decide", "alert:ack", "demo:reset"],
  competent_authority: [...READ, "case:scrutiny", "case:decide", "case:override", "alert:ack"],
  admin: [...READ, "case:upload", "case:resubmit", "case:scrutiny", "case:decide", "case:override", "alert:ack", "demo:reset"],
};

export const can = (a: Actor, p: Permission) => MATRIX[a.role].includes(p);

export function assertCan(a: Actor, p: Permission): void {
  if (!can(a, p)) throw AppError.forbidden(`Role "${a.role}" is not permitted to perform ${p}`);
}
