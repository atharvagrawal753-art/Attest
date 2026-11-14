import { randomUUID } from "node:crypto";
import type { Clock } from "../clock";
import { addDays } from "../clock";
import type { Config } from "../config";
import { EXPIRING_DOCUMENTS, DOC_LABEL, MANDATORY_DOCUMENTS } from "../domain/checklist";
import { isTimed, STATE_LABEL } from "../domain/workflow";
import type { AlertRepository } from "../repositories/types";
import type { Actor, Alert, AlertKind, Case, Severity } from "../types";
import { AppError } from "../errors";
import type { Logger } from "../logger";
import { AuditService, SYSTEM_ACTOR } from "./audit";
import { assertCan } from "./permissions";
import type { EventHub } from "./sse";

/** Who an alert is routed to at each level. Unattended alerts climb this ladder. */
export const ESCALATION_LADDER = ["Scrutiny officer", "Regional officer", "Member Secretary"] as const;
const DAY = 86_400_000;

interface Condition { key: string; caseId: string; kind: AlertKind; severity: Severity; message: string }

export class AlertEngine {
  private timer?: NodeJS.Timeout;
  private scanning = false;

  constructor(
    private alerts: AlertRepository,
    private audit: AuditService,
    private hub: EventHub,
    private clock: Clock,
    private cfg: Pick<Config, "slaDays" | "certExpiryWarningDays" | "escalationAfterMinutes" | "alertScanSeconds">,
    private listCases: () => Promise<Case[]>,
    private log: Logger,
  ) {}

  /** Everything that is wrong or about to be wrong right now. Pure: no writes. */
  conditions(cases: Case[]): Condition[] {
    const now = this.clock.now();
    const out: Condition[] = [];
    for (const c of cases) {
      const tag = `Application ${c.number} (${c.institution.name})`;
      const sla = isTimed(c.state) ? this.cfg.slaDays[c.state] : undefined;
      if (sla) {
        const due = addDays(new Date(c.stateEnteredAt), sla);
        const daysLate = Math.floor((now.getTime() - due.getTime()) / DAY);
        if (now > due) {
          const severity: Severity = daysLate >= 14 ? "critical" : daysLate >= 7 ? "high" : "medium";
          out.push({ key: `STAGE_OVERDUE:${c.id}:${c.state}`, caseId: c.id, kind: "STAGE_OVERDUE", severity,
            message: `${tag} is ${daysLate < 1 ? "past its deadline" : `${daysLate} day${daysLate === 1 ? "" : "s"} past its deadline`} while ${STATE_LABEL[c.state]}` });
        } else if (due.getTime() - now.getTime() <= 2 * DAY) {
          out.push({ key: `STAGE_DUE_SOON:${c.id}:${c.state}`, caseId: c.id, kind: "STAGE_DUE_SOON", severity: "low",
            message: `${tag} must leave "${STATE_LABEL[c.state]}" by ${due.toISOString().slice(0, 10)}` });
        }
      }
      for (const d of c.documents) {
        if (!d.expiresAt || !EXPIRING_DOCUMENTS.includes(d.type)) continue;
        const exp = new Date(d.expiresAt), left = Math.ceil((exp.getTime() - now.getTime()) / DAY);
        if (exp < now) {
          out.push({ key: `COMPLIANCE_LAPSE:${c.id}:${d.id}`, caseId: c.id, kind: "COMPLIANCE_LAPSE", severity: "high",
            message: `${tag}: ${DOC_LABEL[d.type]} expired on ${d.expiresAt.slice(0, 10)}` });
        } else if (left <= this.cfg.certExpiryWarningDays) {
          out.push({ key: `CERTIFICATE_EXPIRING:${c.id}:${d.id}`, caseId: c.id, kind: "CERTIFICATE_EXPIRING", severity: left <= 7 ? "high" : "medium",
            message: `${tag}: ${DOC_LABEL[d.type]} expires in ${left} day${left === 1 ? "" : "s"}` });
        }
      }
      if (c.state === "MONITORING") {
        for (const m of MANDATORY_DOCUMENTS.filter((m) => !c.documents.some((d) => d.type === m.type))) {
          out.push({ key: `COMPLIANCE_LAPSE:${c.id}:missing:${m.type}`, caseId: c.id, kind: "COMPLIANCE_LAPSE", severity: "critical",
            message: `${tag}: mandatory ${m.label.toLowerCase()} is missing after approval` });
        }
      }
    }
    return out;
  }

  /** One pass: raise new alerts, resolve cleared ones, escalate unattended ones. */
  async scan(): Promise<{ raised: number; resolved: number; escalated: number }> {
    if (this.scanning) return { raised: 0, resolved: 0, escalated: 0 };
    this.scanning = true;
    try {
      const nowIso = this.clock.now().toISOString();
      const wanted = this.conditions(await this.listCases());
      const existing = await this.alerts.list();
      const active = new Map(existing.filter((a) => a.status !== "resolved").map((a) => [a.dedupeKey, a]));
      let raised = 0, resolved = 0, escalated = 0;

      for (const w of wanted) {
        const have = active.get(w.key);
        if (have) {
          if (have.severity !== w.severity || have.message !== w.message) { Object.assign(have, { severity: w.severity, message: w.message }); await this.alerts.save(have); }
          continue;
        }
        const a: Alert = {
          id: `alt_${randomUUID().slice(0, 8)}`, caseId: w.caseId, kind: w.kind, severity: w.severity, message: w.message,
          status: "open", level: 1, assignedTo: ESCALATION_LADDER[0], occurredAt: nowIso, lastEscalatedAt: nowIso, dedupeKey: w.key,
        };
        await this.alerts.save(a);
        await this.audit.record("ALERT_RAISED", SYSTEM_ACTOR, { alertId: a.id, kind: a.kind, severity: a.severity, message: a.message }, a.caseId);
        this.hub.publish("alert", a);
        raised++;
      }

      const wantedKeys = new Set(wanted.map((w) => w.key));
      for (const a of active.values()) {
        if (!wantedKeys.has(a.dedupeKey)) {
          a.status = "resolved"; a.resolvedAt = nowIso;
          await this.alerts.save(a);
          await this.audit.record("ALERT_RESOLVED", SYSTEM_ACTOR, { alertId: a.id, reason: "Condition cleared" }, a.caseId);
          this.hub.publish("alert-update", a);
          resolved++;
        }
      }

      const every = this.cfg.escalationAfterMinutes * 60_000;
      for (const a of await this.alerts.list()) {
        if (a.status !== "open" || a.level >= ESCALATION_LADDER.length) continue;
        if (this.clock.now().getTime() - new Date(a.lastEscalatedAt).getTime() < every) continue;
        a.level++; a.assignedTo = ESCALATION_LADDER[a.level - 1]!; a.lastEscalatedAt = nowIso;
        await this.alerts.save(a);
        await this.audit.record("ALERT_ESCALATED", SYSTEM_ACTOR, { alertId: a.id, toLevel: a.level, assignedTo: a.assignedTo }, a.caseId);
        this.hub.publish("alert-update", a);
        escalated++;
      }
      if (raised || resolved || escalated) this.log.info("alert scan", { raised, resolved, escalated });
      return { raised, resolved, escalated };
    } finally { this.scanning = false; }
  }

  async list(opts: { status?: string; limit: number; caseId?: string }, actor: Actor) {
    assertCan(actor, "alert:read");
    const sev: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1 };
    const rows = (await this.alerts.list())
      .filter((a) => (opts.caseId ? a.caseId === opts.caseId : true))
      .filter((a) => !opts.status || opts.status === "all" ? true : opts.status === "active" ? a.status !== "resolved" : a.status === opts.status)
      .sort((a, b) => sev[b.severity] - sev[a.severity] || b.occurredAt.localeCompare(a.occurredAt));
    return { items: rows.slice(0, opts.limit), total: rows.length };
  }

  async acknowledge(id: string, actor: Actor) {
    assertCan(actor, "alert:ack");
    const a = await this.alerts.get(id);
    if (!a) throw AppError.notFound("Alert");
    if (a.status !== "open") throw AppError.conflict("INVALID_STATE", `Alert is already ${a.status}`);
    a.status = "acknowledged"; a.acknowledgedBy = actor.name; a.acknowledgedAt = this.clock.now().toISOString();
    await this.alerts.save(a);
    await this.audit.record("ALERT_ACKNOWLEDGED", actor, { alertId: a.id, level: a.level }, a.caseId);
    this.hub.publish("alert-update", a);
    return a;
  }

  start() {
    void this.scan().catch((e) => this.log.error("alert scan failed", { err: String(e) }));
    this.timer = setInterval(() => void this.scan().catch((e) => this.log.error("alert scan failed", { err: String(e) })), this.cfg.alertScanSeconds * 1000);
    this.timer.unref();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
}
