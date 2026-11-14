import { randomUUID } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { z, type ZodType } from "zod";
import { AppError } from "../errors";
import type { Logger } from "../logger";
import type { TokenService } from "../services/tokens";
import type { Actor } from "../types";

declare module "express-serve-static-core" {
  interface Request { id: string; actor?: Actor }
}

export const requestContext = (log: Logger): RequestHandler => (req, res, next) => {
  const incoming = req.header("x-request-id");
  req.id = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader("X-Request-Id", req.id);
  const t0 = process.hrtime.bigint();
  res.on("finish", () => {
    if (req.path === "/api/health") return;
    log.info("http", { id: req.id, method: req.method, path: req.path, status: res.statusCode, ms: Number(process.hrtime.bigint() - t0) / 1e6 });
  });
  next();
};

export const authenticate = (tokens: TokenService): RequestHandler => (req, _res, next) => {
  const h = req.header("authorization") ?? "";
  const m = /^Bearer (.+)$/.exec(h);
  if (!m) return next(AppError.unauthenticated());
  try { req.actor = tokens.verify(m[1]!); next(); } catch (e) { next(e); }
};

export function actorOf(req: Request): Actor {
  if (!req.actor) throw AppError.unauthenticated();
  return req.actor;
}

/** Parse and type a request part with zod, turning failures into a 400 with field-level details. */
export function parse<S extends ZodType>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw AppError.validation("Request is not valid", r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  return r.data;
}

export const notFound: RequestHandler = (req, _res, next) => next(AppError.notFound(`Route ${req.method} ${req.path}`));

export const errorHandler = (log: Logger) => (err: unknown, req: Request, res: Response, _next: NextFunction) => {
  let e: AppError;
  if (err instanceof AppError) e = err;
  else if (typeof err === "object" && err && "type" in err && (err as { type: string }).type === "entity.too.large") e = new AppError(413, "PAYLOAD_TOO_LARGE", "Request body is too large");
  else if (typeof err === "object" && err && "type" in err && (err as { type: string }).type === "entity.parse.failed") e = AppError.validation("Body is not valid JSON");
  else { e = new AppError(500, "INTERNAL", "Something went wrong"); log.error("unhandled", { id: req.id, err: err instanceof Error ? err.stack : String(err) }); }
  if (res.headersSent) { res.end(); return; }
  res.status(e.status).json({ error: { code: e.code, message: e.message, details: e.details, requestId: req.id } });
};
