import { describe, expect, it } from "vitest";
import { boot, CASE } from "./helpers";

describe("alert engine", () => {
  it("raises alerts for overdue stages and lapsed certificates on start", async () => {
    const { alerts, api, login } = await boot();
    const h = await login();
    const r = await api.get("/api/alerts?status=active&limit=10").set(h).expect(200);
    const kinds = r.body.items.map((a: { kind: string }) => a.kind).sort();
    expect(kinds).toEqual(["CERTIFICATE_EXPIRING", "COMPLIANCE_LAPSE", "STAGE_OVERDUE"]);
    expect(r.body.items.every((a: { caseId: string }) => a.caseId !== CASE)).toBe(true);
    expect((await alerts.scan()).raised).toBe(0); // no duplicates on a second pass
  });

  it("escalates unattended alerts up the ladder and stops at the top", async () => {
    const { alerts, clock } = await boot({ ESCALATION_AFTER_MINUTES: "30" });
    clock.advanceMinutes(31);
    expect((await alerts.scan()).escalated).toBe(3);
    clock.advanceMinutes(31);
    expect((await alerts.scan()).escalated).toBe(3);
    clock.advanceMinutes(31);
    expect((await alerts.scan()).escalated).toBe(0);
  });

  it("stops escalating once an officer acknowledges", async () => {
    const { alerts, api, login, clock } = await boot();
    const h = await login();
    const list = await api.get("/api/alerts?limit=10").set(h);
    const id = list.body.items[0].id;
    await api.post(`/api/alerts/${id}/acknowledge`).set(h).expect(200);
    await api.post(`/api/alerts/${id}/acknowledge`).set(h).expect(409);
    clock.advanceMinutes(31);
    await alerts.scan();
    const after = await api.get("/api/alerts?status=all&limit=10").set(h);
    expect(after.body.items.find((a: { id: string }) => a.id === id).level).toBe(1);
  });

  it("resolves an alert when its condition clears", async () => {
    const { alerts, api, login, clock } = await boot();
    const h = await login();
    clock.advanceDays(40); // the 12-day expiry warning becomes a lapse, so the warning is superseded
    const r = await alerts.scan();
    expect(r.resolved).toBeGreaterThan(0);
    const all = await api.get("/api/alerts?status=resolved&limit=10").set(h);
    expect(all.body.items.some((a: { kind: string }) => a.kind === "CERTIFICATE_EXPIRING")).toBe(true);
  });

  it("issues single-use stream tickets", async () => {
    const { api, login, tickets, tokens } = await boot();
    const h = await login();
    const t = await api.post("/api/stream-ticket").set(h).expect(201);
    expect(t.body.ticket).toHaveLength(48);
    const actor = tokens.verify(h.Authorization.slice(7));
    const second = tickets.issue(actor).ticket;
    tickets.consume(second);
    expect(() => tickets.consume(second)).toThrow();
    await api.get("/api/alerts/stream?ticket=bogusbogusbogusbogus").expect(401);
  });
});
