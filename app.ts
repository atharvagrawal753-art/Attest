import { join, resolve } from "node:path";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { systemClock, type Clock } from "./clock";
import type { Config } from "./config";
import { createLogger, type Logger } from "./logger";
import { errorHandler, notFound, requestContext } from "./middleware/http";
import { FsBlobStore, MemoryAlertRepository, MemoryAuditRepository, MemoryBlobStore, MemoryCaseRepository } from "./repositories/memory";
import { apiRouter } from "./routes";
import { seed } from "./seed";
import { AlertEngine } from "./services/alertEngine";
import { AuditService } from "./services/audit";
import { CaseService } from "./services/caseService";
import { EventHub } from "./services/sse";
import { TicketStore, TokenService } from "./services/tokens";

export interface AppOptions {
  config: Config;
  clock?: Clock;
  logger?: Logger;
  /** Load the synthetic demonstration cases. */
  seedData?: boolean;
  /** Start the background alert scan. Tests drive scans by hand instead. */
  scheduler?: boolean;
  /** Keep uploaded files in memory instead of on disk. */
  memoryBlobs?: boolean;
}

export async function createApp(o: AppOptions) {
  const cfg = o.config;
  const clock = o.clock ?? systemClock;
  const log = o.logger ?? createLogger(cfg.logLevel);

  const caseRepo = new MemoryCaseRepository();
  const alertRepo = new MemoryAlertRepository();
  const auditRepo = new MemoryAuditRepository();
  const blobs = o.memoryBlobs ? new MemoryBlobStore() : new FsBlobStore(join(cfg.dataDir, "blobs"));

  const audit = new AuditService(auditRepo, clock);
  const hub = new EventHub();
  const tokens = new TokenService(cfg.jwtSecret, cfg.jwtTtlSeconds);
  const tickets = new TicketStore(clock);
  const cases = new CaseService(caseRepo, audit, blobs, clock, cfg);
  const alerts = new AlertEngine(alertRepo, audit, hub, clock, cfg, () => cases.all(), log);

  const load = async () => { if (o.seedData !== false) await seed(caseRepo, audit, clock); };
  await load();
  if (o.scheduler) alerts.start(); else if (o.seedData !== false) await alerts.scan();

  const reset = async () => {
    caseRepo.clear(); alertRepo.clear(); auditRepo.clear();
    await load(); await alerts.scan();
  };

  const app = express();
  app.disable("x-powered-by");
  if (cfg.trustProxy) app.set("trust proxy", 1);

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      // The console page uses inline <script>/<style>. Move them to files to drop 'unsafe-inline'.
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"], frameAncestors: ["'none'"],
      },
    },
  }));
  app.use(requestContext(log));

  const small = express.json({ limit: "100kb" });
  const upload = express.json({ limit: Math.ceil(cfg.maxUploadBytes * 1.4) + 4096 });
  app.use("/api", (req, res, next) => (req.method === "POST" && /^\/cases\/[^/]+\/documents$/.test(req.path) ? upload : small)(req, res, next));
  app.use("/api", (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  app.use("/api", rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: "draft-7", legacyHeaders: false, skip: (r) => r.path === "/health" }));
  app.use("/api", apiRouter({ cfg, tokens, tickets, cases, alerts, audit, hub, reset: o.seedData === false ? undefined : reset }));

  app.use(express.static(resolve(__dirname, "../public"), { maxAge: cfg.env === "production" ? "1h" : 0 }));
  app.use(notFound);
  app.use(errorHandler(log));

  return {
    app, cases, alerts, audit, hub, tokens, tickets, auditRepo,
    async shutdown() { alerts.stop(); hub.closeAll(); },
  };
}
