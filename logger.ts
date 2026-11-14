type Level = "debug" | "info" | "warn" | "error" | "silent";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/** Structured JSON-lines logger. Swap for pino/winston behind the same interface if preferred. */
export function createLogger(level: Level = "info"): Logger {
  const emit = (lvl: Exclude<Level, "silent">, msg: string, meta?: Record<string, unknown>) => {
    if (order[lvl] < order[level]) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), level: lvl, msg, ...meta });
    (lvl === "error" || lvl === "warn" ? process.stderr : process.stdout).write(line + "\n");
  };
  return {
    debug: (m, x) => emit("debug", m, x),
    info: (m, x) => emit("info", m, x),
    warn: (m, x) => emit("warn", m, x),
    error: (m, x) => emit("error", m, x),
  };
}
