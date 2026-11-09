/** Sending windows, staggered starts and spacing (SPEC §6.10, playbook rule 11). */
import { DateTime } from "luxon";
import type { CampaignSchedule } from "./types";
import type { Policies } from "./policy";
import { DEFAULT_POLICIES } from "./policy";

const US_STATE_TZ: Record<string, string> = {
  AL: "America/Chicago", AK: "America/Anchorage", AZ: "America/Phoenix", AR: "America/Chicago", CA: "America/Los_Angeles", CO: "America/Denver",
  CT: "America/New_York", DE: "America/New_York", DC: "America/New_York", FL: "America/New_York", GA: "America/New_York", HI: "Pacific/Honolulu",
  ID: "America/Boise", IL: "America/Chicago", IN: "America/Indiana/Indianapolis", IA: "America/Chicago", KS: "America/Chicago", KY: "America/New_York",
  LA: "America/Chicago", ME: "America/New_York", MD: "America/New_York", MA: "America/New_York", MI: "America/Detroit", MN: "America/Chicago",
  MS: "America/Chicago", MO: "America/Chicago", MT: "America/Denver", NE: "America/Chicago", NV: "America/Los_Angeles", NH: "America/New_York",
  NJ: "America/New_York", NM: "America/Denver", NY: "America/New_York", NC: "America/New_York", ND: "America/Chicago", OH: "America/New_York",
  OK: "America/Chicago", OR: "America/Los_Angeles", PA: "America/New_York", RI: "America/New_York", SC: "America/New_York", SD: "America/Chicago",
  TN: "America/Chicago", TX: "America/Chicago", UT: "America/Denver", VT: "America/New_York", VA: "America/New_York", WA: "America/Los_Angeles",
  WV: "America/New_York", WI: "America/Chicago", WY: "America/Denver",
};

const COUNTRY_TZ: Record<string, string> = {
  US: "America/New_York", CA: "America/Toronto", GB: "Europe/London", UK: "Europe/London", IE: "Europe/Dublin", DE: "Europe/Berlin",
  FR: "Europe/Paris", ES: "Europe/Madrid", IT: "Europe/Rome", NL: "Europe/Amsterdam", BE: "Europe/Brussels", CH: "Europe/Zurich",
  AT: "Europe/Vienna", SE: "Europe/Stockholm", NO: "Europe/Oslo", DK: "Europe/Copenhagen", FI: "Europe/Helsinki", PL: "Europe/Warsaw",
  PT: "Europe/Lisbon", AU: "Australia/Sydney", NZ: "Pacific/Auckland", IN: "Asia/Kolkata", SG: "Asia/Singapore", AE: "Asia/Dubai",
  IL: "Asia/Jerusalem", ZA: "Africa/Johannesburg", BR: "America/Sao_Paulo", MX: "America/Mexico_City", JP: "Asia/Tokyo", HK: "Asia/Hong_Kong",
};

const COUNTRY_NAMES: Record<string, string> = {
  "united states": "US", usa: "US", "united states of america": "US", canada: "CA", "united kingdom": "GB", england: "GB", ireland: "IE",
  germany: "DE", france: "FR", spain: "ES", italy: "IT", netherlands: "NL", australia: "AU", "new zealand": "NZ", india: "IN", singapore: "SG",
  "united arab emirates": "AE", israel: "IL", "south africa": "ZA", brazil: "BR", mexico: "MX", japan: "JP", sweden: "SE", switzerland: "CH",
};

export function isValidTimezone(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  return DateTime.now().setZone(tz).isValid;
}

/** Recipient timezone: explicit field → US state → country → campaign default. */
export function resolveTimezone(p: { timezone?: string | null; country?: string | null; state?: string | null }, fallback: string): string {
  if (isValidTimezone(p.timezone)) return p.timezone;
  const cRaw = (p.country ?? "").trim();
  const country = cRaw.length === 2 ? cRaw.toUpperCase() : COUNTRY_NAMES[cRaw.toLowerCase()] ?? "";
  if ((country === "US" || !country) && p.state) {
    const st = US_STATE_TZ[p.state.trim().toUpperCase()];
    if (st) return st;
  }
  if (country && COUNTRY_TZ[country]) return COUNTRY_TZ[country];
  return fallback;
}

/** Is `at` inside the campaign window in the recipient's timezone? */
export function inWindow(at: Date, tz: string, schedule: CampaignSchedule): boolean {
  const local = DateTime.fromJSDate(at).setZone(tz);
  const days = schedule.saturday || schedule.saturdayTestShare > 0 ? [...new Set([...schedule.days, 6])] : schedule.days;
  if (!days.includes(local.weekday)) return false;
  const minutes = local.hour * 60 + local.minute;
  return minutes >= schedule.startHour * 60 && minutes < schedule.endHour * 60;
}

/** Add n business days (campaign sending days) in a timezone, keeping the time of day. */
export function addBusinessDays(from: Date, n: number, tz: string, days: number[] = [1, 2, 3, 4, 5]): Date {
  let d = DateTime.fromJSDate(from).setZone(tz);
  let added = 0;
  if (n <= 0) return d.toJSDate();
  while (added < n) {
    d = d.plus({ days: 1 });
    if (days.includes(d.weekday)) added++;
  }
  return d.toJSDate();
}

export interface SlotParams {
  /** Local calendar date (yyyy-mm-dd) in the mailbox timezone. */
  date: string;
  mailboxTz: string;
  startHour: number;
  endHour: number;
  count: number;
  rand: () => number;
  policies?: Policies;
  /** Slots earlier than this are dropped (planning mid-day). */
  notBefore?: Date;
}

/**
 * Generate send times for one mailbox for one day: randomized start within the jitter window
 * (SCH-2), then randomized gaps spread over the remaining window (SCH-3).
 */
export function planSlots(p: SlotParams): Date[] {
  const policies = p.policies ?? DEFAULT_POLICIES;
  if (p.count <= 0) return [];
  const open = DateTime.fromISO(p.date, { zone: p.mailboxTz }).set({ hour: p.startHour, minute: 0, second: 0, millisecond: 0 });
  const close = open.set({ hour: p.endHour });
  let start = open.plus({ minutes: Math.floor(p.rand() * (policies.schedule.startJitterMaxMin + 1)) });
  const notBefore = p.notBefore ? DateTime.fromJSDate(p.notBefore) : null;
  if (notBefore && notBefore > start) start = notBefore.plus({ minutes: Math.floor(p.rand() * 10) + 1 });
  if (start >= close) return [];
  const windowMin = close.diff(start, "minutes").minutes;
  const base = windowMin / p.count;
  const slots: Date[] = [];
  let t = start;
  for (let i = 0; i < p.count; i++) {
    if (t >= close) break;
    slots.push(t.set({ second: Math.floor(p.rand() * 60) }).toJSDate());
    const jitter = 1 + (p.rand() * 2 - 1) * policies.schedule.gapJitter;
    const gap = Math.max(policies.schedule.minGapMin, base * jitter);
    t = t.plus({ minutes: gap });
  }
  return slots;
}

/** Local date string in a timezone. */
export function localDate(at: Date, tz: string): string {
  return DateTime.fromJSDate(at).setZone(tz).toISODate() ?? "";
}

export function weekdayOf(at: Date, tz: string): number {
  return DateTime.fromJSDate(at).setZone(tz).weekday;
}

/**
 * Saturday test (SCH-5): deterministic assignment of a prospect to the Saturday arm.
 * Uses a hash so the same prospect always lands in the same arm.
 */
export function inSaturdayArm(prospectId: string, share: number): boolean {
  if (share <= 0) return false;
  let h = 0;
  for (let i = 0; i < prospectId.length; i++) h = (h * 31 + prospectId.charCodeAt(i)) >>> 0;
  return (h % 1000) / 1000 < share;
}
