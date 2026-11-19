// Everything around the board: demo bar, masthead with range switcher and status, ticker,
// warnings, footer.

import type { MouseEvent } from "react";
import type { Board } from "../shared/api.ts";
import { hrefFor, navigate, RANGES, REFRESH_MS, useNow } from "./data.ts";
import type { BoardState, UrlState } from "./data.ts";
import { ago, clockFor, duration } from "./format.ts";
import { SCENARIOS } from "./mock.ts";
import { castOf, Snout } from "./ui.tsx";

function go(event: MouseEvent<HTMLAnchorElement>) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const href = event.currentTarget.getAttribute("href");
  if (!href) return;
  event.preventDefault();
  navigate(href);
}

export function DemoBar({ url }: { url: UrlState }) {
  return (
    <aside className="demo" aria-label="Demo mode">
      <strong>Demo mode</strong>
      <span className="demo-note">Fake suspects, fake receipts.</span>
      <nav className="demo-links" aria-label="Demo scenario">
        {SCENARIOS.map((s) => (
          <a key={s.key} href={hrefFor({ scenario: s.key })} onClick={go} aria-current={url.scenario === s.key ? "page" : undefined} title={s.hint}>
            {s.label}
          </a>
        ))}
      </nav>
    </aside>
  );
}

// Collector lag thresholds, from the contract: the collector polls every few seconds, so a
// minute without a successful pull means it is behind and five minutes means the data is stale.
const LAGGING_SECONDS = 60;
const STALE_SECONDS = 300;

export interface Health {
  level: "loading" | "live" | "lagging" | "stale" | "never" | "offline";
  label: string;
  /** Longer sentence for the warning strip, null when all is well. */
  warning: string | null;
  /** Seconds the collector is behind right now, null if unknown. */
  lag: number | null;
}

export function healthOf(state: BoardState, now: number): Health {
  const { board, error, fetchedAt } = state;
  if (!board || fetchedAt === null) return { level: error ? "offline" : "loading", label: error ? "Offline" : "Loading", warning: null, lag: null };
  const sinceFetch = Math.max(0, (now - fetchedAt) / 1000);
  const lag = board.collectorLagSeconds === null ? null : board.collectorLagSeconds + sinceFetch;
  if (error) {
    return {
      level: "offline",
      label: "Offline",
      warning: `Lost the server. Showing the last snapshot from ${clockFor(board.timezone).time(board.generatedAt)} (${ago(now - fetchedAt)}); still trying to reconnect.`,
      lag,
    };
  }
  if (lag === null) {
    return { level: "never", label: "No sync", warning: "The collector has never successfully pulled from the proxy, so new requests aren't landing here yet.", lag };
  }
  if (lag > STALE_SECONDS) {
    return { level: "stale", label: "Stale", warning: `Cold leftovers: the collector last heard from the proxy ${duration(lag)} ago. Everything below is at least that old.`, lag };
  }
  if (lag > LAGGING_SECONDS) {
    return { level: "lagging", label: "Lagging", warning: `The collector is running ${duration(lag)} behind the proxy. Fresh prompts may not be on the board yet.`, lag };
  }
  return { level: "live", label: "Live", warning: null, lag };
}

function StatusPill({ state }: { state: BoardState }) {
  const now = useNow(1000);
  const health = healthOf(state, now);
  const { fetchedAt, nextAt, loading, board } = state;
  const sub =
    fetchedAt === null
      ? state.error
        ? "retrying"
        : "fetching"
      : health.level === "offline"
        ? `cached ${ago(now - fetchedAt)}`
        : health.level === "never"
          ? "awaiting collector"
          : (health.level === "stale" || health.level === "lagging") && health.lag !== null
            ? `${duration(health.lag)} behind`
            : `checked ${ago(now - fetchedAt)}`;
  const facts = [
    health.lag !== null ? `Collector synced ${duration(health.lag)} ago` : board ? "Collector has never synced" : null,
    board?.lastEventAt ? `Last request at ${clockFor(board.timezone).timeSec(board.lastEventAt)}` : null,
    "Auto-refreshes every 30s",
  ].filter(Boolean);
  return (
    <button type="button" className={`status status-${health.level}`} onClick={state.refresh} title={`${facts.join(" · ")}. Click to force a refresh.`} aria-label={`Status: ${health.label}, ${sub}. Refresh now`}>
      <i className="status-dot" aria-hidden="true" />
      <span className="status-label">{health.label}</span>
      <span className="status-sub">{sub}</span>
      {nextAt !== null && !loading ? <i key={nextAt} className="status-timer" style={{ animationDuration: `${Math.max(1, nextAt - Date.now())}ms` }} aria-hidden="true" /> : null}
    </button>
  );
}

const COUNT_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

/** "four engineers": the people who have a key, spelled out the way the copy wants it. */
function headcount(board: Board | null, noun: string): string {
  const n = board ? board.people.filter((p) => !p.unassigned).length : 0;
  if (n === 0) return `several ${noun}s`;
  return `${COUNT_WORDS[n] ?? n} ${noun}${n === 1 ? "" : "s"}`;
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const TAGLINES: ((board: Board | null) => string)[] = [
  (board) => `${capitalise(headcount(board, "developer"))}. One proxy. Zero shame.`,
  () => "A public record of private weakness",
  () => "Billing the flat rate to the bone",
  () => "All the compute that's fit to waste",
  () => "Your keyboard called. It misses you.",
  () => "Turning electricity into git revert",
  () => "Live from the shared subscription",
  () => "Proof nobody here reads the docs anymore",
  () => "Quantifying the death of manual typing",
  () => "Who needs craft when you have context",
  () => "Official weigh-in for the token Olympics",
  () => "Every prompt judged. None forgiven.",
  () => "Proudly subsidised by VC money",
  () => "Not a productivity metric. A cry for help.",
];

export function Masthead({ url, state }: { url: UrlState; state: BoardState }) {
  const board = state.board;
  const tagline = TAGLINES[Math.floor(Date.now() / 86_400_000) % TAGLINES.length]?.(board);
  return (
    <header className="masthead">
      <div className="brand">
        <h1 className="wordmark" aria-label="Slopboard">
          <span aria-hidden="true">
            SL
            <Snout />
            PBOARD
          </span>
        </h1>
        <p className="tagline">{tagline}</p>
      </div>
      <div className="controls">
        <nav className="ranges" aria-label="Time range">
          {RANGES.map((r) => (
            <a key={r.key} href={hrefFor({ range: r.key })} onClick={go} aria-current={url.range === r.key ? "page" : undefined} className={state.loading && url.range === r.key && board?.range !== r.key ? "is-pending" : undefined}>
              {r.label}
            </a>
          ))}
        </nav>
        <StatusPill state={state} />
      </div>
    </header>
  );
}

export function Alerts({ state }: { state: BoardState }) {
  const now = useNow(5000);
  const health = healthOf(state, now);
  if (!health.warning) return null;
  return (
    <div className={`alert alert-${health.level}`} role="status">
      <span className="alert-tag" aria-hidden="true">
        {health.level === "offline" ? "Offline" : health.level === "lagging" ? "Lagging" : health.level === "never" ? "No sync" : "Stale"}
      </span>
      <p>
        {health.warning}
        {health.level === "offline" && state.error ? <code>{state.error}</code> : null}
      </p>
    </div>
  );
}

const IDLE_HEADLINES: ((board: Board | null) => string)[] = [
  (board) => `Breaking: ${headcount(board, "engineer")} reportedly typing their own code`,
  () => "Zero tokens burned — historic restraint or broken proxy",
  () => "Trophy cabinet wide open, standards currently on the floor",
  () => "First prompt takes #1, no questions asked",
  () => "The shared subscription sits idle, tragically un-abused",
  () => "Sources confirm nobody has asked an LLM to center a div today",
  () => "All medals unclaimed — somebody blink first",
];
const DOWN_HEADLINES = [
  "Broadcast interrupted — server not answering",
  "Slopboard temporarily blind, burn tokens at will",
  "Technical difficulties — nobody panic, nobody deploy",
  "Holding pattern — retrying the server automatically",
  "Signal lost — assume whoever is quietest is currently winning",
  "Stand by — we are definitely still logging this somewhere",
];

export function Ticker({ board, down = false }: { board: Board | null; down?: boolean }) {
  let items: { key: string; emoji: string; head: string; tail: string }[] = [];
  if (board) {
    const cast = castOf(board);
    for (const a of board.awards) {
      if (a.winnerId) items.push({ key: "a" + a.id, emoji: a.emoji, head: `${a.title}: ${cast.name(a.winnerId)}`, tail: a.value ?? "" });
    }
    for (const r of board.records) {
      items.push({ key: "r" + r.id, emoji: r.emoji, head: `${r.title}: ${r.value}`, tail: r.personId ? cast.name(r.personId) : "group effort" });
    }
  }
  if (items.length === 0) items = (down ? DOWN_HEADLINES : IDLE_HEADLINES.map((line) => line(board))).map((head, i) => ({ key: "i" + i, emoji: "", head, tail: "" }));
  const row = (hidden: boolean) => (
    <ul className="ticker-row" aria-hidden={hidden || undefined}>
      {items.map((it) => (
        <li key={it.key}>
          {it.emoji ? <span className="emoji">{it.emoji}</span> : null}
          <b>{it.head}</b>
          {it.tail ? <span>{it.tail}</span> : null}
        </li>
      ))}
    </ul>
  );
  return (
    // The same facts are in the trophy cabinet and the record book below: this strip is décor.
    <div className="ticker" aria-hidden="true">
      <div className="ticker-track" style={{ animationDuration: `${Math.max(30, items.length * 7)}s` }}>
        {row(false)}
        {row(true)}
      </div>
    </div>
  );
}

export function Footer({ board, mock }: { board: Board | null; mock: boolean }) {
  const clock = board ? clockFor(board.timezone) : null;
  return (
    <footer className="footer">
      <p>
        <b>About the pretend bill.</b> "Fake invoice" is what these tokens would cost at public API list rates. Nobody here is paying it — we're on flat subscriptions, so the only ones losing money are the labs. "Unpriced" means we don't know a model's list rate yet, not that it's free.
      </p>
      <p>
        {board && clock ? (
          <>
            All timestamps in {board.timezone} ({clock.offsetName}). Printed {clock.stamp(board.generatedAt)}. Re-checked every {REFRESH_MS / 1000}s.
          </>
        ) : (
          <>Re-checked every {REFRESH_MS / 1000}s.</>
        )}
        {mock ? " Demo data — drop ?mock=1 from the URL for the actual culprits." : null}
      </p>
      <p className="footer-sign">Slopboard. Built to settle arguments nobody should be proud of winning.</p>
    </footer>
  );
}
