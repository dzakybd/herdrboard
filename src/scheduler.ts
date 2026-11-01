// Trigger grammar (one string, so it is easy to type in the UI and CLI):
//   "every 30m" | "every 2h" | "every 1d" | "daily 09:00" | "weekdays 09:00" | "weekly mon 09:00"
// Ported from ovis-automation/supervisor/scheduler.ts.

export type Trigger =
  | { type: "every"; ms: number }
  | { type: "daily"; h: number; m: number }
  | { type: "weekdays"; h: number; m: number }
  | { type: "weekly"; weekday: number; h: number; m: number };

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

function parseClock(at: string): { h: number; m: number } {
  const c = at.match(/^(\d{1,2}):(\d{2})$/);
  if (!c) throw new Error(`invalid time '${at}' (expected HH:MM)`);
  const h = Number(c[1]), m = Number(c[2]);
  if (h > 23 || m > 59) throw new Error(`invalid time '${at}'`);
  return { h, m };
}

export function parseTrigger(text: string): Trigger {
  const parts = text.trim().toLowerCase().split(/\s+/);
  const [kind, a, b] = parts;
  if (kind === "every" && a && parts.length === 2) {
    const iv = a.match(/^(\d+)([mhd])$/);
    if (!iv || Number(iv[1]) <= 0) throw new Error(`invalid interval '${a}' (expected e.g. 30m, 2h, 1d)`);
    return { type: "every", ms: Number(iv[1]) * UNIT_MS[iv[2] as keyof typeof UNIT_MS] };
  }
  if ((kind === "daily" || kind === "weekdays") && a && parts.length === 2) return { type: kind, ...parseClock(a) };
  if (kind === "weekly" && a && b && parts.length === 3) {
    const weekday = WEEKDAYS.indexOf(a.slice(0, 3));
    if (weekday < 0) throw new Error(`invalid weekday '${a}'`);
    return { type: "weekly", weekday, ...parseClock(b) };
  }
  throw new Error(`invalid trigger '${text}' (use "every 30m", "daily 09:00", "weekdays 09:00" or "weekly mon 09:00")`);
}

function dayAt(base: number, dayOffset: number, h: number, m: number): number {
  const d = new Date(base);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

function matches(t: Trigger, ms: number): boolean {
  const day = new Date(ms).getDay();
  if (t.type === "weekly") return day === t.weekday;
  return t.type !== "weekdays" || (day >= 1 && day <= 5);
}

function lastSlotAtOrBefore(t: Exclude<Trigger, { type: "every" }>, now: number): number | null {
  for (let day = 0; day <= 8; day++) {
    const cand = dayAt(now, -day, t.h, t.m);
    if (cand <= now && matches(t, cand)) return cand;
  }
  return null;
}

/**
 * `last` is the last fire time, floored at the automation's creation time.
 * Clock triggers are due when a slot passed after `last`, so a slot missed
 * while the machine slept fires on the first tick after wake.
 */
export function isDue(t: Trigger, last: number, now: number): boolean {
  if (t.type === "every") return now - last >= t.ms;
  const slot = lastSlotAtOrBefore(t, now);
  return slot !== null && slot > last;
}

export function nextDue(t: Trigger, last: number, now: number): number {
  if (t.type === "every") return last + t.ms;
  const from = Math.max(last, lastSlotAtOrBefore(t, now) ?? 0);
  for (let day = 0; day <= 9; day++) {
    const cand = dayAt(from, day, t.h, t.m);
    if (cand > from && matches(t, cand)) return cand;
  }
  return from + 7 * UNIT_MS.d;
}
