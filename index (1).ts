import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import type { Config } from "../config";
import { AppError } from "../errors";
import { actorOf, authenticate, parse } from "../middleware/http";
import type { AlertEngine } from "../services/alertEngine";
import type { AuditService } from "../services/audit";
import type { CaseService } from "../services/caseService";
import { assertCan } from "../services/permissions";
import type { EventHub } from "../services/sse";
import type { TicketStore, TokenService } from "../services/tokens";
import type { Actor } from "../types";

export interface Deps {
  cfg: Config;
  tokens: TokenService;
  tickets: TicketStore;
  cases: CaseService;
  alerts: AlertEngine;
  audit: AuditService;
  hub: EventHub;
  reset?: () => Promise<void>;
}

const caseId = z.string().regex(/^AICTE-\d{4}-\d{4,6}$/, "Invalid application id");
const limit = (max: number, def: number) => z.coerce.number().int().min(1).max(max).default(def);

const decisionBody = z.object({
  decision: z.enum(["Approved", "Correction requested", "Rejected"]),
  reason: z.string().trim().min(3, "A reason is required").max(1000),
  override: z.boolean().optional(),
});

const fieldValue = z.object({ value: z.union([z.string().max(300), z.number(), z.null()]), page: z.number().int().min(1).max(10_000).optional() });
const uploadBody = z.object({
  type: z.enum(["application_form", "faculty_certificate", "infrastructure_report", "fire_safety_certificate"]),
  filename: z.string().trim().min(1).max(200),
  mimeType: z.string(),
  contentBase64: z.string().min(4),
  expiresAt: z.iso.datetime().optional(),
  declaredFields: z.record(z.string().max(60), fieldValue).optional(),
});

const DEMO_ACTOR: Actor = { id: "demo-reviewer", name: "Reviewer", role: "reviewer" };

export function apiRouter(d: Deps): Router {
  const r = Router();
  const auth = authenticate(d.tokens);

  // ---- Health (no auth, no rate limit) --------------------------------------------------------
  r.get("/health", (_req, res) => { res.json({ status: "ok", uptime: Math.round(process.uptime()) }); });
  r.get("/ready", async (_req, res) => {
    const audit = await d.audit.verify();
    res.status(audit.valid ? 200 : 503).json({ status: audit.valid ? "ready" : "audit-chain-broken", auditEntries: audit.entries });
  });

  // ---- Sessions -------------------------------------------------------------------------------
  if (d.cfg.demoMode) {
    const strict = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: "draft-7", legacyHeaders: false });
    r.post("/session/demo", strict, (_req, res) => {
      res.status(201).json({ ...d.tokens.issue(DEMO_ACTOR), actor: DEMO_ACTOR });
    });
  }
  r.get("/session", auth, (req, res) => { res.json({ actor: actorOf(req) }); });

  // ---- Applications ---------------------------------------------------------------------------
  r.get("/cases", auth, async (req, res) => { res.json({ items: await d.cases.list(actorOf(req)) }); });
  r.get("/cases/:id", auth, async (req, res) => { res.json(await d.cases.get(parse(caseId, req.params["id"]), actorOf(req))); });
  r.get("/cases/:id/preview", auth, async (req, res) => { res.json(await d.cases.preview(parse(caseId, req.params["id"]), actorOf(req))); });
  r.get("/cases/:id/report", auth, async (req, res) => { res.json(await d.cases.latestReport(parse(caseId, req.params["id"]), actorOf(req))); });
  r.post("/cases/:id/scrutiny", auth, async (req, res) => { res.json(await d.cases.runScrutiny(parse(caseId, req.params["id"]), actorOf(req))); });
  r.post("/cases/:id/decision", auth, async (req, res) => {
    res.json(await d.cases.decide(parse(caseId, req.params["id"]), actorOf(req), parse(decisionBody, req.body)));
  });
  r.post("/cases/:id/resubmit", auth, async (req, res) => { res.json(await d.cases.resubmit(parse(caseId, req.params["id"]), actorOf(req))); });
  r.post("/cases/:id/documents", auth, async (req, res) => {
    res.status(201).json(await d.cases.addDocument(parse(caseId, req.params["id"]), actorOf(req), parse(uploadBody, req.body)));
  });
  r.get("/cases/:id/audit", auth, async (req, res) => {
    const actor = actorOf(req); assertCan(actor, "audit:read");
    const id = parse(caseId, req.params["id"]);
    await d.cases.get(id, actor); // 404 for unknown or out-of-scope applications
    const n = parse(z.object({ limit: limit(200, 50) }), req.query).limit;
    res.json({ items: await d.audit.recent(n, id) });
  });

  // ---- Audit integrity ------------------------------------------------------------------------
  r.get("/audit/verify", auth, async (req, res) => { assertCan(actorOf(req), "audit:read"); res.json(await d.audit.verify()); });

  // ---- Alerts ---------------------------------------------------------------------------------
  r.get("/alerts", auth, async (req, res) => {
    const q = parse(z.object({
      status: z.enum(["active", "open", "acknowledged", "resolved", "all"]).default("active"),
      limit: limit(100, 20), caseId: caseId.optional(),
    }), req.query);
    res.json(await d.alerts.list(q, actorOf(req)));
  });
  r.post("/alerts/:id/acknowledge", auth, async (req, res) => {
    res.json(await d.alerts.acknowledge(parse(z.string().regex(/^alt_[a-f0-9]{8}$/), req.params["id"]), actorOf(req)));
  });
  r.post("/stream-ticket", auth, (req, res) => {
    assertCan(actorOf(req), "alert:read");
    res.status(201).json(d.tickets.issue(actorOf(req)));
  });
  r.get("/alerts/stream", (req, res) => {
    const ticket = parse(z.object({ ticket: z.string().min(16).max(128) }), req.query).ticket;
    d.tickets.consume(ticket);
    d.hub.add(res);
  });

  // ---- Demo reset -----------------------------------------------------------------------------
  if (d.cfg.demoMode && d.reset) {
    r.post("/demo/reset", auth, async (req, res) => {
      assertCan(actorOf(req), "demo:reset");
      await d.reset!();
      res.json({ message: "Demonstration data restored" });
    });
  }

  r.use((_req, _res, next) => next(AppError.notFound("Endpoint")));
  return r;
}
