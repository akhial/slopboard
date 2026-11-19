import { expect, test } from "bun:test";
import { displayModelName, fmtCount, fmtDay, fmtDuration, fmtPct, fmtUsd, fmtWhen, plural, slugify } from "../format.ts";

test("model ids become names people recognise", () => {
  const cases: [string, string][] = [
    ["claude-opus-4-5-20251101", "Claude Opus 4.5"],
    ["claude-fable-5-2", "Claude Fable 5.2"],
    ["claude-3-7-sonnet-20250219", "Claude 3.7 Sonnet"],
    ["gpt-5.3-codex(high)", "GPT-5.3 Codex"],
    ["gpt-5.1-codex-mini", "GPT-5.1 Codex Mini"],
    ["gpt-5.2-2025-12-11", "GPT-5.2"],
    ["gemini-3.1-pro-preview", "Gemini 3.1 Pro Preview"],
    ["gemini/gemini-2.5-pro", "Gemini 2.5 Pro"],
    ["o3-mini", "o3 Mini"],
    ["glm-5.1", "GLM 5.1"],
    ["grok-4-fast", "Grok 4 Fast"],
    ["kimi-k2", "Kimi k2"],
    ["unknown", "Unknown"],
  ];
  for (const [id, name] of cases) expect(displayModelName(id)).toBe(name);
});

test("numbers", () => {
  expect([0, 999, 1000, 1234, 14_000, 99_949, 99_950, 999_499, 999_500, 41_234_000, 170_400_000, 3_772_853_154].map(fmtCount)).toEqual([
    "0", "999", "1K", "1.2K", "14K", "99.9K", "100K", "999K", "1M", "41.2M", "170M", "3.8B",
  ]);
  expect([0, 0.004, 0.0142, 7.456, 43.02, 571.58, 1555.2].map(fmtUsd)).toEqual(["$0.00", "<$0.01", "$0.01", "$7.46", "$43.02", "$572", "$1,555"]);
  expect([0, 0.004, 0.5, 0.876, 1].map(fmtPct)).toEqual(["0%", "0%", "50%", "88%", "100%"]);
  expect([843, 9000, 14_300, 74_000, 843_000, 33_120_000, 201_600_000].map(fmtDuration)).toEqual([
    "0.8s", "9.0s", "14s", "1m 14s", "14m 03s", "9h 12m", "2d 8h",
  ]);
  expect([plural(1, "subagent"), plural(0, "subagent"), plural(1204, "request")]).toEqual(["1 subagent", "0 subagents", "1,204 requests"]);
});

test("moments are written in the board's timezone", () => {
  const at = new Date("2026-11-17T17:10:00Z");
  expect(fmtWhen(at, "UTC", false)).toBe("Tue 17:10");
  expect(fmtWhen(at, "Asia/Tokyo", false)).toBe("Wed 02:10");
  expect(fmtWhen(at, "Asia/Tokyo", true)).toBe("Wed 18 Nov 02:10");
  expect(fmtWhen(new Date("2026-11-17T00:05:00Z"), "UTC", false)).toBe("Tue 00:05");
  expect(fmtDay(at, "America/Los_Angeles")).toBe("Tue 17 Nov");
});

test("slugs", () => {
  expect(slugify("Ada Lovelace")).toBe("ada-lovelace");
  expect(slugify("  Tomás Echeverría ")).toBe("tomas-echeverria");
  expect(slugify("already-a-slug")).toBe("already-a-slug");
  expect(slugify("!!!")).toBe("");
});
