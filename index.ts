import { randomBytes } from "node:crypto";
import { z } from "zod";

const bool = z.enum(["true", "false"]).transform((v) => v === "true");
const int = (def: number, min = 0) => z.coerce.number().int().min(min).default(def);

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: int(3000, 1),
  HOST: z.string().default("0.0.0.0"),
  JWT_SECRET: z.string().optional(),
  JWT_TTL_SECONDS: int(3600, 60),
  DEMO_MODE: bool.optional(),
  DATA_DIR: z.string().default("./data"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),
  TRUST_PROXY: bool.default(false),
  ALERT_SCAN_SECONDS: int(30, 1),
  ESCALATION_AFTER_MINUTES: int(30, 1),
  MIN_FACULTY: int(40, 1),
  SLA_DAYS_SUBMITTED: int(3, 1),
  SLA_DAYS_SCRUTINY: int(10, 1),
  SLA_DAYS_EXPERT_REVIEW: int(21, 1),
  SLA_DAYS_CORRECTION_REQUESTED: int(30, 1),
  CERT_EXPIRY_WARNING_DAYS: int(30, 1),
  MAX_UPLOAD_BYTES: int(8 * 1024 * 1024, 1024),
});

export interface Config {
  env: "development" | "test" | "production";
  port: number;
  host: string;
  jwtSecret: string;
  jwtTtlSeconds: number;
  demoMode: boolean;
  dataDir: string;
  logLevel: "debug" | "info" | "warn" | "error" | "silent";
  trustProxy: boolean;
  alertScanSeconds: number;
  escalationAfterMinutes: number;
  minFaculty: number;
  slaDays: { SUBMITTED: number; SCRUTINY: number; EXPERT_REVIEW: number; CORRECTION_REQUESTED: number };
  certExpiryWarningDays: number;
  maxUploadBytes: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${msg}`);
  }
  const e = parsed.data;
  const production = e.NODE_ENV === "production";
  const demoMode = e.DEMO_MODE ?? !production;
  if (production && (!e.JWT_SECRET || e.JWT_SECRET.length < 32)) {
    throw new Error("Invalid configuration: JWT_SECRET must be set to 32+ characters in production");
  }
  if (production && demoMode) {
    throw new Error("Invalid configuration: DEMO_MODE must be false in production");
  }
  return {
    env: e.NODE_ENV,
    port: e.PORT,
    host: e.HOST,
    jwtSecret: e.JWT_SECRET && e.JWT_SECRET.length >= 32 ? e.JWT_SECRET : randomBytes(32).toString("hex"),
    jwtTtlSeconds: e.JWT_TTL_SECONDS,
    demoMode,
    dataDir: e.DATA_DIR,
    logLevel: e.LOG_LEVEL,
    trustProxy: e.TRUST_PROXY,
    alertScanSeconds: e.ALERT_SCAN_SECONDS,
    escalationAfterMinutes: e.ESCALATION_AFTER_MINUTES,
    minFaculty: e.MIN_FACULTY,
    slaDays: {
      SUBMITTED: e.SLA_DAYS_SUBMITTED,
      SCRUTINY: e.SLA_DAYS_SCRUTINY,
      EXPERT_REVIEW: e.SLA_DAYS_EXPERT_REVIEW,
      CORRECTION_REQUESTED: e.SLA_DAYS_CORRECTION_REQUESTED,
    },
    certExpiryWarningDays: e.CERT_EXPIRY_WARNING_DAYS,
    maxUploadBytes: e.MAX_UPLOAD_BYTES,
  };
}
