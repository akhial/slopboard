// Number and time formatting shared by the UI and the mock generator.

const UNITS = ["", "K", "M", "B", "T"] as const;

/** 950 -> "950", 12_400_000 -> "12.4M", 1_310_000_000 -> "1.31B". Always three significant digits. */
export function compact(n: number): string {
  if (!Number.isFinite(n)) return "–";
  const sign = n < 0 ? "-" : "";
  let v = Math.abs(n);
  if (v < 1000) return sign + String(Math.round(v));
  let unit = 0;
  while (v >= 1000 && unit < UNITS.length - 1) {
    v /= 1000;
    unit++;
  }
  // Rounding can push 999.96K to "1000K"; move up a unit instead.
  if (v >= 999.5 && unit < UNITS.length - 1) {
    v /= 1000;
    unit++;
  }
  const digits = v >= 99.95 ? 0 : v >= 9.995 ? 1 : 2;
  return sign + v.toFixed(digits) + UNITS[unit];
}

/** Full number with thousands separators, for tooltips. */
export function full(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** USD at a glance. Callers handle null (unpriced) themselves: it is not $0. */
export function usd(n: number): string {
  if (!Number.isFinite(n)) return "–";
  if (n === 0) return "$0";
  if (n < 0.01) return "<$0.01";
  if (n < 100) return "$" + n.toFixed(2);
  if (n < 10_000) return "$" + Math.round(n).toLocaleString("en-US");
  return "$" + compact(n);
}

export function pct(share: number): string {
  if (!Number.isFinite(share)) return "–";
  const v = share * 100;
  if (v > 0 && v < 1) return "<1%";
  if (v > 99 && v < 100) return ">99%";
  return Math.round(v) + "%";
}

/** 42 -> "42s", 250 -> "4m", 7500 -> "2h 5m", 200000 -> "2d 7h". */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

export function hourLabel(hour: number): string {
  return String(hour).padStart(2, "0") + ":00";
}

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

export interface Clock {
  timezone: string;
  /** "14:32" */
  time(iso: string | number): string;
  /** "14:32:07" */
  timeSec(iso: string | number): string;
  /** "Tue 14:32" */
  dayTime(iso: string | number): string;
  /** "Tue 19 Nov" */
  date(iso: string | number): string;
  /** "19" */
  dayOfMonth(iso: string | number): string;
  /** "Tue" */
  weekday(iso: string | number): string;
  /** "Nov" */
  month(iso: string | number): string;
  /** "19 Nov 2026, 14:32" */
  stamp(iso: string | number): string;
  /** "GMT+1" */
  offsetName: string;
}

const clocks = new Map<string, Clock>();

/** Formatter bound to the board timezone. Falls back to UTC if the browser does not know the zone. */
export function clockFor(timezone: string): Clock {
  const hit = clocks.get(timezone);
  if (hit) return hit;
  let zone = timezone;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
  } catch {
    zone = "UTC";
  }
  const make = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { timeZone: zone, hourCycle: "h23", ...o });
  const fTime = make({ hour: "2-digit", minute: "2-digit" });
  const fSec = make({ hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const fDayTime = make({ weekday: "short", hour: "2-digit", minute: "2-digit" });
  const fDate = make({ weekday: "short", day: "numeric", month: "short" });
  const fDom = make({ day: "numeric" });
  const fWd = make({ weekday: "short" });
  const fMonth = make({ month: "short" });
  const fStamp = make({ day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const run = (f: Intl.DateTimeFormat, v: string | number) => {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? "–" : f.format(d).replace(",", "");
  };
  let offsetName = zone;
  try {
    const part = make({ timeZoneName: "shortOffset" })
      .formatToParts(new Date())
      .find((p) => p.type === "timeZoneName");
    if (part) offsetName = part.value.replace("GMT", "UTC");
  } catch {
    // Older engines: the zone name alone is fine.
  }
  const clock: Clock = {
    timezone: zone,
    time: (v) => run(fTime, v),
    timeSec: (v) => run(fSec, v),
    dayTime: (v) => run(fDayTime, v),
    date: (v) => run(fDate, v),
    dayOfMonth: (v) => run(fDom, v),
    weekday: (v) => run(fWd, v),
    month: (v) => run(fMonth, v),
    stamp: (v) => run(fStamp, v),
    offsetName,
  };
  clocks.set(timezone, clock);
  return clock;
}

/** "just now", "42s ago", "4m ago" ... */
export function ago(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 5) return "just now";
  return duration(s) + " ago";
}
