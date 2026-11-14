export interface Clock { now(): Date }
export const systemClock: Clock = { now: () => new Date() };

/** Controllable clock for tests and simulations. */
export class FakeClock implements Clock {
  constructor(private t: Date = new Date("2026-11-15T09:00:00.000Z")) {}
  now() { return new Date(this.t); }
  advanceMs(ms: number) { this.t = new Date(this.t.getTime() + ms); }
  advanceDays(d: number) { this.advanceMs(d * 86_400_000); }
  advanceMinutes(m: number) { this.advanceMs(m * 60_000); }
}
export const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
