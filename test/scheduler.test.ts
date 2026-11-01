import { describe, test, expect } from "bun:test";
import { parseTrigger, isDue, nextDue } from "../src/scheduler.ts";

describe("parseTrigger", () => {
  test("parses the three forms", () => {
    expect(parseTrigger("every 30m")).toEqual({ type: "every", ms: 1_800_000 });
    expect(parseTrigger("daily 09:00")).toEqual({ type: "daily", h: 9, m: 0 });
    expect(parseTrigger("weekly Monday 14:30")).toEqual({ type: "weekly", weekday: 1, h: 14, m: 30 });
  });
  test("rejects garbage", () => {
    for (const bad of ["every 30", "every 0m", "daily 25:00", "weekly xyz 09:00", "hourly", "every 30m extra"]) {
      expect(() => parseTrigger(bad)).toThrow();
    }
  });
});

describe("isDue", () => {
  const now = new Date(2026, 9, 28, 10, 0).getTime(); // Wed 10:00
  test("every: due once the interval elapsed", () => {
    const t = parseTrigger("every 30m");
    expect(isDue(t, now - 60_000, now)).toBe(false);
    expect(isDue(t, now - 1_800_000, now)).toBe(true);
  });
  test("daily: waits for the slot, fires a missed slot on wake", () => {
    const created = new Date(2026, 9, 28, 8, 0).getTime();
    expect(isDue(parseTrigger("daily 14:30"), created, now)).toBe(false);
    expect(isDue(parseTrigger("daily 09:00"), created, now)).toBe(true);
    expect(isDue(parseTrigger("daily 09:00"), new Date(2026, 9, 28, 9, 1).getTime(), now)).toBe(false);
  });
  test("weekly: only on the chosen weekday", () => {
    const created = new Date(2026, 9, 28, 8, 0).getTime();
    expect(isDue(parseTrigger("weekly wed 09:00"), created, now)).toBe(true);
    expect(isDue(parseTrigger("weekly fri 09:00"), created, now)).toBe(false);
  });
  test("weekdays: skips the weekend", () => {
    const t = parseTrigger("weekdays 09:00");
    expect(t).toEqual({ type: "weekdays", h: 9, m: 0 });
    const friEvening = new Date(2026, 9, 30, 18, 0).getTime();
    const sunNoon = new Date(2026, 10, 1, 12, 0).getTime();
    const monNoon = new Date(2026, 10, 2, 12, 0).getTime();
    expect(isDue(t, friEvening, sunNoon)).toBe(false);
    expect(isDue(t, friEvening, monNoon)).toBe(true);
    expect(nextDue(t, friEvening, sunNoon)).toBe(new Date(2026, 10, 2, 9, 0).getTime());
  });
  test("nextDue gives the next slot", () => {
    expect(nextDue(parseTrigger("daily 14:30"), 0, now)).toBe(new Date(2026, 9, 28, 14, 30).getTime());
    expect(nextDue(parseTrigger("daily 09:00"), 0, now)).toBe(new Date(2026, 9, 29, 9, 0).getTime());
    expect(nextDue(parseTrigger("weekly fri 09:00"), 0, now)).toBe(new Date(2026, 9, 30, 9, 0).getTime());
  });
});
