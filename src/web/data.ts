// URL state and the polling loop that keeps the board fresh.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { BOARD_PATH } from "../shared/api.ts";
import type { Board, RangeKey } from "../shared/api.ts";
import { registerPeople } from "./colors.ts";
import { loadMockBoard, parseScenario } from "./mock.ts";
import type { Scenario } from "./mock.ts";

export const RANGES: readonly { key: RangeKey; label: string; short: string; phrase: string; previous: string }[] = [
  { key: "today", label: "Today", short: "Today", phrase: "today", previous: "yesterday" },
  { key: "7d", label: "7 days", short: "7d", phrase: "in the last 7 days", previous: "the 7 days before" },
  { key: "30d", label: "30 days", short: "30d", phrase: "in the last 30 days", previous: "the 30 days before" },
  { key: "all", label: "All time", short: "All", phrase: "since records began", previous: "" },
];

export const DEFAULT_RANGE: RangeKey = "7d";
export const REFRESH_MS = 30_000;
const RETRY_MS = 12_000;
const REQUEST_TIMEOUT_MS = 20_000;

export function rangeInfo(key: RangeKey) {
  return RANGES.find((r) => r.key === key) ?? RANGES[1]!;
}

export interface UrlState {
  range: RangeKey;
  mock: boolean;
  scenario: Scenario;
}

function parse(search: string): UrlState {
  const q = new URLSearchParams(search);
  const range = RANGES.find((r) => r.key === q.get("range"))?.key ?? DEFAULT_RANGE;
  const mock = q.has("mock") && q.get("mock") !== "0" && q.get("mock") !== "false";
  return { range, mock, scenario: mock ? parseScenario(q.get("scenario")) : "normal" };
}

/** A link to the same page with some of the state changed. Unknown parameters are kept. */
export function hrefFor(patch: Partial<UrlState>): string {
  const q = new URLSearchParams(location.search);
  if (patch.range) {
    if (patch.range === DEFAULT_RANGE) q.delete("range");
    else q.set("range", patch.range);
  }
  if (patch.scenario) {
    if (patch.scenario === "normal") q.delete("scenario");
    else q.set("scenario", patch.scenario);
  }
  const text = q.toString();
  return location.pathname + (text ? "?" + text : "");
}

const listeners = new Set<() => void>();
function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  window.addEventListener("popstate", fn);
  return () => {
    listeners.delete(fn);
    window.removeEventListener("popstate", fn);
  };
}

/** Client-side navigation for the range and demo links: no reload, back button still works. */
export function navigate(href: string): void {
  if (href === location.pathname + location.search) return;
  history.pushState(null, "", href);
  for (const fn of listeners) fn();
}

export function useUrlState(): UrlState {
  const search = useSyncExternalStore(subscribe, () => location.search);
  const cache = useRef<{ search: string; state: UrlState } | null>(null);
  if (!cache.current || cache.current.search !== search) cache.current = { search, state: parse(search) };
  return cache.current.state;
}

function looksLikeBoard(value: unknown): value is Board {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.people) && Array.isArray(v.models) && typeof v.totals === "object" && v.totals !== null && typeof v.timeline === "object" && v.timeline !== null;
}

async function fetchBoard(range: RangeKey, signal: AbortSignal): Promise<Board> {
  let res: Response;
  try {
    res = await fetch(`${BOARD_PATH}?range=${encodeURIComponent(range)}`, { signal, headers: { accept: "application/json" }, cache: "no-store" });
  } catch (err) {
    if (signal.aborted) throw err;
    throw new Error("No answer from the server. Check that it's running and you're on the right network.");
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Handled below: a non-JSON body is an error either way.
  }
  if (!res.ok) {
    const message = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : res.statusText || "no details";
    throw new Error(`${res.status}: ${message}`);
  }
  if (!looksLikeBoard(body)) throw new Error("The server replied, just not with a board.");
  return body;
}

export interface BoardState {
  /** The latest board that loaded. It can be for another range while a switch is in flight. */
  board: Board | null;
  /** Why the latest attempt failed, or null if it worked. */
  error: string | null;
  loading: boolean;
  /** Client clock when `board` arrived. */
  fetchedAt: number | null;
  /** Client clock of the next automatic attempt. */
  nextAt: number | null;
  refresh: () => void;
}

/**
 * Loads the board for the URL's range and reloads it every 30 seconds.
 * The previous board stays on screen until the next one has arrived, so refreshes never blank
 * the page, and a failed refresh leaves the last good board in place.
 */
export function useBoard(url: UrlState): BoardState {
  const [state, setState] = useState<Omit<BoardState, "refresh">>({ board: null, error: null, loading: true, fetchedAt: null, nextAt: null });
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  const source = `${url.mock ? "mock" : "live"}:${url.scenario}`;
  const lastSource = useRef(source);

  useEffect(() => {
    if (lastSource.current !== source) {
      lastSource.current = source;
      setState({ board: null, error: null, loading: true, fetchedAt: null, nextAt: null });
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let nextDue = 0;
    let running = false;

    const schedule = (ms: number) => {
      clearTimeout(timer);
      nextDue = Date.now() + ms;
      timer = setTimeout(load, ms);
      setState((s) => ({ ...s, nextAt: nextDue }));
    };

    async function load() {
      if (running || controller.signal.aborted) return;
      if (document.hidden) {
        // Nobody is looking: wait until the tab is visible again.
        nextDue = 0;
        return;
      }
      running = true;
      setState((s) => ({ ...s, loading: true }));
      const attempt = new AbortController();
      const abort = () => attempt.abort();
      controller.signal.addEventListener("abort", abort);
      const timeout = setTimeout(abort, REQUEST_TIMEOUT_MS);
      try {
        const board = url.mock ? await loadMockBoard(url.range, url.scenario, attempt.signal) : await fetchBoard(url.range, attempt.signal);
        if (controller.signal.aborted) return;
        registerPeople(board.people);
        setState((s) => ({ ...s, board, error: null, loading: false, fetchedAt: Date.now() }));
        schedule(REFRESH_MS);
      } catch (err) {
        if (controller.signal.aborted) return;
        const message = attempt.signal.aborted ? "The server timed out before answering." : err instanceof Error ? err.message : String(err);
        setState((s) => ({ ...s, error: message, loading: false }));
        schedule(RETRY_MS);
      } finally {
        running = false;
        clearTimeout(timeout);
        controller.signal.removeEventListener("abort", abort);
      }
    }

    const onVisible = () => {
      if (!document.hidden && Date.now() >= nextDue) void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [url.range, url.mock, url.scenario, source, tick]);

  return { ...state, refresh };
}

/** A clock that re-renders its caller every `ms`, for "12s ago" labels. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}
