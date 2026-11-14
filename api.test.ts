import { describe, expect, it } from "vitest";
import { boot, CASE, png } from "./helpers";

describe("authentication", () => {
  it("rejects calls without a session", async () => {
    const { api } = await boot();
    const r = await api.get("/api/cases").expect(401);
    expect(r.body.error.code).toBe("UNAUTHENTICATED");
  });
  it("rejects a forged token", async () => {
    const { api } = await boot();
    await api.get("/api/cases").set("Authorization", "Bearer abc.def.ghi").expect(401);
  });
  it("does not expose the demo session when demo mode is off", async () => {
    const { api } = await boot({ DEMO_MODE: "false" });
    await api.post("/api/session/demo").expect(404);
  });
});

describe("scrutiny and decision", () => {
  it("serves the contract the console expects", async () => {
    const { api, login } = await boot();
    const h = await login();
    const p = await api.get(`/api/cases/${CASE}/preview`).set(h).expect(200);
    expect(p.body.fields).toHaveLength(5);
    const s = await api.post(`/api/cases/${CASE}/scrutiny`).set(h).expect(200);
    expect(s.body).toMatchObject({ score: 72, summary: "2 passed, 1 conflict, 1 missing" });
    expect(s.body.rules).toEqual(expect.arrayContaining([expect.objectContaining({ title: "Mandatory documents attached", result: "Missing" })]));
  });

  it("blocks approval while a mandatory document is missing", async () => {
    const { api, login } = await boot();
    const h = await login();
    const r = await api.post(`/api/cases/${CASE}/decision`).set(h).send({ decision: "Approved", reason: "Looks fine" }).expect(409);
    expect(r.body.error.code).toBe("MANDATORY_DOCUMENT_MISSING");
  });

  it("refuses an override from a role that may not override", async () => {
    const { api, login } = await boot();
    const h = await login();
    const r = await api.post(`/api/cases/${CASE}/decision`).set(h)
      .send({ decision: "Approved", reason: "Override because the certificate is in progress", override: true }).expect(403);
    expect(r.body.error.code).toBe("FORBIDDEN");
  });

  it("records a correction request, then refuses a second decision", async () => {
    const { api, login } = await boot();
    const h = await login();
    const ok = await api.post(`/api/cases/${CASE}/decision`).set(h).send({ decision: "Correction requested", reason: "Fire certificate missing" }).expect(200);
    expect(ok.body.message).toBe("Correction requested – Application 4839");
    const again = await api.post(`/api/cases/${CASE}/decision`).set(h).send({ decision: "Rejected", reason: "No longer valid" }).expect(409);
    expect(again.body.error.code).toBe("INVALID_STATE");
  });

  it("allows a competent authority to override with a written reason", async () => {
    const { api, tokens } = await boot();
    const h = { Authorization: `Bearer ${tokens.issue({ id: "ca-1", name: "Competent Authority", role: "competent_authority" }).token}` };
    const short = await api.post(`/api/cases/${CASE}/decision`).set(h).send({ decision: "Approved", reason: "Fine by me ok", override: true }).expect(400);
    expect(short.body.error.code).toBe("VALIDATION_ERROR");
    const ok = await api.post(`/api/cases/${CASE}/decision`).set(h)
      .send({ decision: "Approved", reason: "Certificate renewal confirmed in writing by the fire department", override: true }).expect(200);
    expect(ok.body.message).toContain("override recorded");
    expect(ok.body.state).toBe("MONITORING");
  });

  it("validates input", async () => {
    const { api, login } = await boot();
    const h = await login();
    const r = await api.post(`/api/cases/${CASE}/decision`).set(h).send({ decision: "Maybe", reason: "" }).expect(400);
    expect(r.body.error.details.length).toBeGreaterThan(0);
    await api.get("/api/cases/not-an-id/preview").set(h).expect(400);
    await api.get("/api/cases/AICTE-2026-9999/preview").set(h).expect(404);
  });

  it("writes every step to a verifiable audit trail", async () => {
    const { api, login } = await boot();
    const h = await login();
    await api.post(`/api/cases/${CASE}/scrutiny`).set(h).expect(200);
    await api.post(`/api/cases/${CASE}/decision`).set(h).send({ decision: "Rejected", reason: "Documents incomplete" }).expect(200);
    const a = await api.get(`/api/cases/${CASE}/audit?limit=50`).set(h).expect(200);
    const actions = a.body.items.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["CASE_RECEIVED", "SCRUTINY_COMPLETED", "DECISION_RECORDED", "STATE_CHANGED"]));
    const v = await api.get("/api/audit/verify").set(h).expect(200);
    expect(v.body.valid).toBe(true);
  });
});

describe("documents", () => {
  const inst = (tokens: { issue: (a: never) => { token: string } }, id = "inst-4839") =>
    ({ Authorization: `Bearer ${tokens.issue({ id: "u1", name: "Registrar", role: "institution", institutionId: id } as never).token}` });

  it("stores an upload with its SHA-256 and clears the blocker", async () => {
    const { api, tokens } = await boot();
    const h = inst(tokens);
    const up = await api.post(`/api/cases/${CASE}/documents`).set(h).send({
      type: "fire_safety_certificate", filename: "fire.png", mimeType: "image/png", contentBase64: png.toString("base64"),
      expiresAt: "2027-12-31T00:00:00.000Z",
    }).expect(201);
    expect(up.body.sha256).toMatch(/^[a-f0-9]{64}$/);
    const p = await api.get(`/api/cases/${CASE}/preview`).set(h).expect(200);
    expect(p.body.blockers).toEqual([]);
  });

  it("rejects a file whose bytes do not match its declared type", async () => {
    const { api, tokens } = await boot();
    const r = await api.post(`/api/cases/${CASE}/documents`).set(inst(tokens)).send({
      type: "fire_safety_certificate", filename: "x.pdf", mimeType: "application/pdf", contentBase64: Buffer.from("not a pdf").toString("base64"),
    }).expect(415);
    expect(r.body.error.code).toBe("UNSUPPORTED_MEDIA");
  });

  it("hides other institutions' applications from an institution user", async () => {
    const { api, tokens } = await boot();
    const h = inst(tokens, "inst-other");
    await api.get(`/api/cases/${CASE}`).set(h).expect(404);
    const list = await api.get("/api/cases").set(h).expect(200);
    expect(list.body.items).toEqual([]);
  });
});
