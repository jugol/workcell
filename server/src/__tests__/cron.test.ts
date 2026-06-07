import { describe, expect, it } from "vitest";
import {
  cronMatchesDay,
  nextCronTickFromExpression,
  parseCron,
  validateCron,
} from "../services/cron.ts";

describe("parseCron", () => {
  it("expands fields and records day-field restriction flags", () => {
    const cron = parseCron("0 9 * * 1-5"); // 09:00 on weekdays
    expect(cron.minutes).toEqual([0]);
    expect(cron.hours).toEqual([9]);
    expect(cron.months).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(cron.daysOfMonth).toEqual(Array.from({ length: 31 }, (_, i) => i + 1));
    expect(cron.daysOfWeek).toEqual([1, 2, 3, 4, 5]);
    // day-of-month is `*` (unrestricted); day-of-week is restricted
    expect(cron.daysOfMonthRestricted).toBe(false);
    expect(cron.daysOfWeekRestricted).toBe(true);
  });

  it("flags both day fields as restricted when neither is `*`", () => {
    const cron = parseCron("0 0 13 * 5");
    expect(cron.daysOfMonthRestricted).toBe(true);
    expect(cron.daysOfWeekRestricted).toBe(true);
  });

  it("treats step/range/list day-of-week tokens as restricted", () => {
    expect(parseCron("0 0 * * 1,3,5").daysOfWeekRestricted).toBe(true);
    expect(parseCron("0 0 1-15 * *").daysOfMonthRestricted).toBe(true);
    expect(parseCron("0 0 */2 * *").daysOfMonthRestricted).toBe(true);
    expect(parseCron("0 0 * * *").daysOfMonthRestricted).toBe(false);
    expect(parseCron("0 0 * * *").daysOfWeekRestricted).toBe(false);
  });

  it("rejects malformed expressions", () => {
    expect(validateCron("0 0 13 * 5")).toBeNull();
    expect(validateCron("0 0 * *")).toMatch(/exactly 5 fields/);
    expect(validateCron("99 0 * * *")).toMatch(/out of range/);
    expect(validateCron("")).toMatch(/must not be empty/);
  });
});

describe("cronMatchesDay — POSIX/Vixie day-of-month vs day-of-week semantics", () => {
  it("ORs the two fields when BOTH are restricted (`13 * 5` ⇒ 13th OR Friday)", () => {
    const cron = parseCron("0 0 13 * 5"); // DOM=13, DOW=Fri
    // the 13th on a non-Friday (e.g. a Tuesday) still matches via day-of-month
    expect(cronMatchesDay(cron, 13, 2)).toBe(true);
    // a Friday that is not the 13th (e.g. the 6th) still matches via day-of-week
    expect(cronMatchesDay(cron, 6, 5)).toBe(true);
    // Friday the 13th matches (both)
    expect(cronMatchesDay(cron, 13, 5)).toBe(true);
    // a day that is neither the 13th nor a Friday does NOT match
    expect(cronMatchesDay(cron, 6, 2)).toBe(false);
  });

  it("ANDs (reduces to day-of-month) when day-of-week is `*`", () => {
    const cron = parseCron("0 0 15 * *"); // 15th, any weekday
    expect(cron.daysOfWeekRestricted).toBe(false);
    expect(cronMatchesDay(cron, 15, 0)).toBe(true);
    expect(cronMatchesDay(cron, 15, 3)).toBe(true);
    expect(cronMatchesDay(cron, 16, 3)).toBe(false); // not the 15th — no OR-in of weekdays
  });

  it("ANDs (reduces to day-of-week) when day-of-month is `*`", () => {
    const cron = parseCron("0 0 * * 1"); // Mondays, any date
    expect(cron.daysOfMonthRestricted).toBe(false);
    expect(cronMatchesDay(cron, 1, 1)).toBe(true);
    expect(cronMatchesDay(cron, 15, 1)).toBe(true);
    expect(cronMatchesDay(cron, 15, 2)).toBe(false); // a Tuesday — no OR-in of dates
  });

  it("matches every day when both fields are `*`", () => {
    const cron = parseCron("0 0 * * *");
    expect(cronMatchesDay(cron, 1, 0)).toBe(true);
    expect(cronMatchesDay(cron, 31, 6)).toBe(true);
  });
});

describe("nextCronTick", () => {
  it("computes the next minute-aligned UTC tick", () => {
    const next = nextCronTickFromExpression("0 * * * *", new Date("2026-03-21T10:15:00.000Z"));
    expect(next?.toISOString()).toBe("2026-03-21T11:00:00.000Z");
  });

  it("honours OR semantics for `13 * 5` (finds the next Friday, not the next Friday-the-13th)", () => {
    // 2026 Friday-the-13ths: Feb 13, Mar 13, Nov 13. Starting Sat Mar 21, a
    // pure-AND ("Friday the 13th") schedule would jump ~238 days to Nov 13.
    // POSIX OR semantics fire on the next Friday (Mar 27) — within a week.
    const after = new Date("2026-03-21T00:00:00.000Z");
    const next = nextCronTickFromExpression("0 0 13 * 5", after);
    expect(next).not.toBeNull();
    const daysOut = (next!.getTime() - after.getTime()) / 86_400_000;
    expect(daysOut).toBeLessThanOrEqual(7);
    // the resulting day satisfies the 13th OR a Friday
    expect(next!.getUTCDate() === 13 || next!.getUTCDay() === 5).toBe(true);
    expect(next!.getUTCHours()).toBe(0);
    expect(next!.getUTCMinutes()).toBe(0);
  });

  it("still requires the exact date when day-of-week is `*` (`13 * *` ⇒ only the 13th)", () => {
    // From Sat Mar 21 2026 the next 13th is Apr 13 — Fridays are NOT OR-ed in.
    const next = nextCronTickFromExpression("0 0 13 * *", new Date("2026-03-21T00:00:00.000Z"));
    expect(next?.getUTCDate()).toBe(13);
    expect(next?.toISOString()).toBe("2026-04-13T00:00:00.000Z");
  });
});
