import { describe, expect, it } from "vitest";
import { boot } from "./helpers";

describe("audit trail", () => {
  it("verifies an untouched chain", async () => {
    const { audit } = await boot();
    const v = await audit.verify();
    expect(v.valid).toBe(true);
    expect(v.entries).toBeGreaterThan(5);
  });

  it("detects an edited entry", async () => {
    const { audit, auditRepo } = await boot();
    auditRepo._tamper(2, { details: { type: "forged" } });
    const v = await audit.verify();
    expect(v.valid).toBe(false);
    expect(v.brokenAtSeq).toBe(3);
    expect(v.reason).toBe("entry content changed");
  });

  it("detects a sequence gap", async () => {
    const { audit, auditRepo } = await boot();
    auditRepo._tamper(1, { seq: 99 });
    expect((await audit.verify()).valid).toBe(false);
  });
});
