// Display formatting for the strings the server hands to the UI ready-made.

import { stripThinkingSuffix } from "./ingest.ts";

function trimZero(value: string): string {
  return value.includes(".") ? value.replace(/\.?0+$/, "") : value;
}

const UNITS = [
  [1e3, "K"],
  [1e6, "M"],
  [1e9, "B"],
] as const;

/** 950 -> "950", 41_234_000 -> "41.2M": three significant digits at most. */
export function fmtCount(n: number): string {
  const abs = Math.abs(n);
  if (abs < 999.5) return String(Math.round(n));
  const sign = n < 0 ? "-" : "";
  for (const [div, unit] of UNITS) {
    const scaled = abs / div;
    const text = scaled < 99.95 ? scaled.toFixed(1) : scaled.toFixed(0);
    // "1000K" reads better as "1M".
    if (Number(text) < 1000 || unit === "B") return sign + trimZero(text) + unit;
  }
  return String(n);
}

export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

export function fmtUsd(n: number): string {
  if (n >= 1000) return `$${Math.round(n).toLocaleString("en-US")}`;
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 0.01 || n === 0) return `$${n.toFixed(2)}`;
  return "<$0.01";
}

export function fmtPct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/** 843 -> "0.8s", 74_000 -> "1m 14s", 33_120_000 -> "9h 12m". */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const total = Math.round(s);
  const d = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m ${String(total % 60).padStart(2, "0")}s`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${fmtInt(n)} ${n === 1 ? one : many}`;
}

function parts(date: Date, tz: string, options: Intl.DateTimeFormatOptions): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-GB", { timeZone: tz, hourCycle: "h23", ...options }).formatToParts(date)) {
    out[p.type] = p.value;
  }
  return out;
}

/** "Tue 02:10", or "Tue 12 Nov 02:10" when the weekday alone would be ambiguous. */
export function fmtWhen(date: Date, tz: string, withDate: boolean): string {
  const p = parts(date, tz, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return withDate
    ? `${p.weekday} ${p.day} ${p.month} ${p.hour}:${p.minute}`
    : `${p.weekday} ${p.hour}:${p.minute}`;
}

/** "Wed 12 Nov". */
export function fmtDay(date: Date, tz: string): string {
  const p = parts(date, tz, { weekday: "short", day: "numeric", month: "short" });
  return `${p.weekday} ${p.day} ${p.month}`;
}

const UPPER = new Set(["gpt", "glm", "ai", "xl", "oss", "tts", "hd"]);

/** "claude-opus-4-5-20251101" -> "Claude Opus 4.5", "gpt-5.3-codex(high)" -> "GPT-5.3 Codex". */
export function displayModelName(id: string): string {
  let s = stripThinkingSuffix(id.trim());
  s = s.split("/").pop() ?? s;
  s = s
    .replace(/-v\d+:\d+$/, "")
    .replace(/[-@](20\d{6})$/, "")
    .replace(/-(20\d{2}-\d{2}-\d{2})$/, "");
  const words: string[] = [];
  for (const token of s.split(/[-_\s]+/).filter(Boolean)) {
    const prev = words[words.length - 1];
    if (/^\d{1,2}$/.test(token) && prev !== undefined && /^\d{1,2}$/.test(prev)) {
      // "4", "5" -> "4.5"
      words[words.length - 1] = `${prev}.${token}`;
    } else if (/^\d/.test(token) && prev === "GPT") {
      words[words.length - 1] = `GPT-${token}`;
    } else if (UPPER.has(token.toLowerCase())) {
      words.push(token.toUpperCase());
    } else if (/^[a-z]\d/.test(token)) {
      // "o3", "k2": model generations read better as written.
      words.push(token);
    } else {
      words.push(token.charAt(0).toUpperCase() + token.slice(1));
    }
  }
  return words.join(" ") || id;
}

/** "Ada Lovelace" -> "ada-lovelace". Empty when nothing usable is left. */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}
