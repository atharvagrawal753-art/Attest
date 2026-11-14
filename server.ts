import { loadConfig } from "./config";
import { createLogger } from "./logger";
import { createApp } from "./app";

async function main() {
  const cfg = loadConfig();
  const log = createLogger(cfg.logLevel);
  const ctx = await createApp({ config: cfg, logger: log, scheduler: true });

  const server = ctx.app.listen(cfg.port, cfg.host, () => {
    log.info("attest api listening", { url: `http://${cfg.host === "0.0.0.0" ? "localhost" : cfg.host}:${cfg.port}`, env: cfg.env, demoMode: cfg.demoMode });
  });

  let closing = false;
  const stop = (signal: string) => {
    if (closing) return;
    closing = true;
    log.info("shutting down", { signal });
    void ctx.shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("unhandledRejection", (e) => log.error("unhandledRejection", { err: String(e) }));
}

main().catch((e) => { process.stderr.write(`${e instanceof Error ? e.message : e}\n`); process.exit(1); });
