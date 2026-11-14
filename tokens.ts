import { randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";
import type { Clock } from "../clock";
import { AppError } from "../errors";
import type { Actor, Role } from "../types";

const ISSUER = "attest-api";
const AUDIENCE = "attest-console";

export class TokenService {
  constructor(private secret: string, private ttlSeconds: number) {}

  issue(actor: Actor): { token: string; expiresIn: number } {
    const token = jwt.sign({ name: actor.name, role: actor.role, inst: actor.institutionId }, this.secret, {
      algorithm: "HS256", subject: actor.id, issuer: ISSUER, audience: AUDIENCE, expiresIn: this.ttlSeconds,
    });
    return { token, expiresIn: this.ttlSeconds };
  }

  verify(token: string): Actor {
    try {
      const p = jwt.verify(token, this.secret, { algorithms: ["HS256"], issuer: ISSUER, audience: AUDIENCE }) as jwt.JwtPayload;
      return { id: String(p.sub), name: String(p["name"]), role: p["role"] as Role, institutionId: p["inst"] as string | undefined };
    } catch {
      throw AppError.unauthenticated("Session is missing, invalid or expired");
    }
  }
}

/** Single-use, short-lived tickets. Browsers cannot send an Authorization header on EventSource, and a
 *  long-lived token in a URL would leak into logs, so the stream is opened with a 30 second ticket instead. */
export class TicketStore {
  private m = new Map<string, { actor: Actor; exp: number }>();
  constructor(private clock: Clock, private ttlMs = 30_000) {}

  issue(actor: Actor): { ticket: string; expiresIn: number } {
    this.sweep();
    const ticket = randomBytes(24).toString("hex");
    this.m.set(ticket, { actor, exp: this.clock.now().getTime() + this.ttlMs });
    return { ticket, expiresIn: Math.floor(this.ttlMs / 1000) };
  }

  consume(ticket: string): Actor {
    const t = this.m.get(ticket);
    this.m.delete(ticket);
    if (!t || t.exp < this.clock.now().getTime()) throw AppError.unauthenticated("Stream ticket is invalid or expired");
    return t.actor;
  }

  private sweep() {
    const now = this.clock.now().getTime();
    for (const [k, v] of this.m) if (v.exp < now) this.m.delete(k);
  }
}
