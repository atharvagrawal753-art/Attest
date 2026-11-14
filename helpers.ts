import request from "supertest";
import { createApp } from "../src/app";
import { FakeClock } from "../src/clock";
import { loadConfig } from "../src/config";

export const CASE = "AICTE-2026-4839";

export async function boot(env: Record<string, string> = {}) {
  const clock = new FakeClock();
  const config = loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent", ...env });
  const ctx = await createApp({ config, clock, seedData: true, scheduler: false, memoryBlobs: true });
  const api = request(ctx.app);
  const login = async () => {
    const r = await api.post("/api/session/demo").expect(201);
    return { Authorization: `Bearer ${r.body.token}` };
  };
  return { ...ctx, clock, api, login, config };
}

export const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
