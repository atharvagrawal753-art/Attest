import { describe, expect, it } from "vitest";
import { evaluateCase } from "../src/domain/scrutiny";
import { canTransition, transition } from "../src/domain/workflow";
import { boot, CASE } from "./helpers";

describe("scrutiny engine", () => {
  it("reproduces the sample result shown in the console", async () => {
    const { cases, clock } = await boot();
    const c = (await cases.all()).find((x) => x.id === CASE)!;
    const r = evaluateCase(c, { minFaculty: 40, reviewCredit: 0.6, now: clock.now() });
    expect(r.score).toBe(72);
    expect(r.summary).toBe("2 passed, 1 conflict, 1 missing");
    expect(r.fields.map((f) => f.status)).toEqual(["ok", "ok", "ok", "bad", "miss"]);
    expect(r.fields[3]!.cells).toEqual(["42", "–", "38"]);
    expect(r.rules.map((x) => x.result)).toEqual(["Pass", "Pass", "Review", "Missing"]);
    expect(r.evidence).toContain("lecture rooms read as 42 on the application form (page 2) and 38 on the infrastructure report (page 1)");
    expect(r.blockers.map((b) => b.type)).toEqual(["fire_safety_certificate"]);
  });

  it("scores 100 when documents agree and nothing is missing", async () => {
    const { cases, clock } = await boot();
    const c = (await cases.all()).find((x) => x.id === "AICTE-2026-4712")!;
    const r = evaluateCase(c, { minFaculty: 40, reviewCredit: 0.6, now: clock.now() });
    expect(r.score).toBe(100);
    expect(r.blockers).toEqual([]);
  });

  it("flags faculty below the configured minimum", async () => {
    const { cases, clock } = await boot();
    const c = (await cases.all()).find((x) => x.id === "AICTE-2026-4712")!;
    const r = evaluateCase(c, { minFaculty: 100, reviewCredit: 0.6, now: clock.now() });
    expect(r.rules.find((x) => x.id === "FACULTY_MINIMUM")!.result).toBe("Review");
  });
});

describe("workflow", () => {
  it("allows only legal transitions", () => {
    expect(transition("SUBMITTED", "START_SCRUTINY")).toBe("SCRUTINY");
    expect(canTransition("REJECTED", "APPROVE")).toBe(false);
    expect(() => transition("SUBMITTED", "APPROVE")).toThrow(/not allowed/);
  });
});
