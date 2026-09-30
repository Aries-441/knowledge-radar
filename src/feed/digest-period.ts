import type { DigestSchedule } from "./config.js";

export type DigestPeriod = {
  key: string;
  start: Date;
  end: Date;
  periodStart: string;
  periodEnd: string;
};

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number };

function localParts(value: Date, timezone: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(value);
  const get = (name: string) => Number(parts.find(part => part.type === name)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

function dateText(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

function addDays(text: string, days: number): string {
  const date = new Date(`${text}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function zonedMidnight(text: string, timezone: string): Date {
  const [year, month, day] = text.split("-").map(Number);
  const naive = Date.UTC(year, month - 1, day);
  const probe = new Date(naive);
  const part = localParts(probe, timezone);
  const represented = Date.UTC(part.year, part.month - 1, part.day, part.hour, part.minute);
  return new Date(naive - (represented - naive));
}

function isoWeek(text: string): { year: number; week: number } {
  const date = new Date(`${text}T00:00:00Z`);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const year = date.getUTCFullYear();
  const first = new Date(Date.UTC(year, 0, 1));
  return { year, week: Math.ceil((((date.valueOf() - first.valueOf()) / 86_400_000) + 1) / 7) };
}

/** Calculates a stable key and timezone-aware window for the schedule period containing `now`. */
export function getDigestPeriod(schedule: DigestSchedule, now: Date | number, timezone: string): DigestPeriod {
  const local = localParts(new Date(now), timezone);
  const today = dateText(local.year, local.month, local.day);
  let startText = today;
  let key: string;
  if (schedule.frequency === "daily") {
    key = today;
  } else if (schedule.frequency === "weekly") {
    const day = new Date(`${today}T00:00:00Z`).getUTCDay() || 7;
    startText = addDays(today, 1 - day);
    const week = isoWeek(startText);
    key = `${week.year}-W${String(week.week).padStart(2, "0")}`;
  } else {
    const anchor = schedule.anchorDate!;
    const days = Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${anchor}T00:00:00Z`)) / 86_400_000);
    const size = schedule.intervalWeeks! * 7;
    // The anchor is the send date. The first window is the completed interval immediately before it.
    const index = Math.floor(days / size) - 1;
    startText = addDays(anchor, index * size);
    key = `${startText}/${addDays(startText, size - 1)}`;
  }
  const endText = schedule.frequency === "daily" ? addDays(startText, 1) : schedule.frequency === "weekly" ? addDays(startText, 7) : addDays(startText, schedule.intervalWeeks! * 7);
  return { key, start: zonedMidnight(startText, timezone), end: zonedMidnight(endText, timezone), periodStart: startText, periodEnd: addDays(endText, -1) };
}

export const calculateDigestPeriod = getDigestPeriod;

/** A schedule is due once its local send time has been reached in its current period. */
export function isDigestScheduleDue(schedule: DigestSchedule, now: Date | number, timezone: string): boolean {
  const local = localParts(new Date(now), timezone);
  const [hour, minute] = schedule.time.split(":").map(Number);
  if (!(local.hour > hour || (local.hour === hour && local.minute >= minute))) return false;
  const today = dateText(local.year, local.month, local.day);
  if (schedule.frequency === "daily") return true;
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay() || 7;
  if (schedule.frequency === "weekly") return weekday === schedule.weekday;
  const anchor = schedule.anchorDate!;
  const days = Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${anchor}T00:00:00Z`)) / 86_400_000);
  return days >= 0 && days % (schedule.intervalWeeks! * 7) === 0;
}
