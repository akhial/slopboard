// What the page shows when there is no board to show, or nothing on it.

import type { MouseEvent } from "react";
import type { Board, RangeKey } from "../shared/api.ts";
import { hrefFor, navigate, rangeInfo, RANGES } from "./data.ts";
import { Snout } from "./ui.tsx";

function Trough({ tipped = false }: { tipped?: boolean }) {
  return (
    <svg className={`trough ${tipped ? "is-tipped" : ""}`} viewBox="0 0 240 150" aria-hidden="true">
      <g className="trough-body">
        <path className="trough-shell" d="M22 62 H218 L196 126 H44 Z" />
        <path className="trough-rim" d="M12 50 H228 V66 H12 Z" />
        <path className="trough-leg" d="M58 126 V142 M182 126 V142" />
        <path className="trough-shine" d="M52 82 H112 M52 96 H88" />
      </g>
      {tipped ? <path className="trough-spill" d="M150 132 C176 120 204 126 226 140 C200 148 172 148 150 132 Z" /> : null}
    </svg>
  );
}

export function Loading() {
  return (
    <main className="state state-loading" aria-busy="true">
      <Snout className="snout-big is-sniffing" />
      <h2>Auditing the slop…</h2>
      <p>Pulling everyone's receipts.</p>
    </main>
  );
}

export function Down({ error, onRetry, loading }: { error: string; onRetry: () => void; loading: boolean }) {
  return (
    <main className="state state-down">
      <Trough tipped />
      <h2>The board has flatlined</h2>
      <p>Can't reach the server right now. It will retry on its own every few seconds, or you can mash the button like it's a 429.</p>
      <pre className="state-error" role="alert">
        {error}
      </pre>
      <button type="button" className="btn" onClick={onRetry} disabled={loading}>
        {loading ? "Retrying…" : "Retry now"}
      </button>
    </main>
  );
}

/** Day one: the store is empty, nobody has made a request through the proxy yet. */
export function DayOne({ board }: { board: Board }) {
  const keys = board.people.filter((p) => !p.unassigned).length;
  return (
    <section className="state state-empty" aria-labelledby="empty-title">
      <Trough />
      <h2 id="empty-title">Clean slate. Suspiciously clean.</h2>
      <p>
        Not a single request has crossed the proxy yet, so nobody has anything to answer for.{" "}
        {keys > 0 ? `${keys} ${keys === 1 ? "person has a key and hasn't touched it" : "people have keys and haven't touched them"}. ` : null}
        The first person to send a prompt takes #1 by default and keeps the crown until someone out-burns them.{" "}
        {board.collectorLagSeconds === null ? "(Fair warning: the collector hasn't checked in yet either, so it might not be your fault.)" : "The collector is awake and watching the wire."}
      </p>
      <ul className="state-steps">
        <li>
          <b>1</b> Point Claude Code or Codex at the shared proxy.
        </li>
        <li>
          <b>2</b> Ask it to refactor something that already worked.
        </li>
        <li>
          <b>3</b> Watch your name climb the board within a minute.
        </li>
      </ul>
    </section>
  );
}

function go(event: MouseEvent<HTMLAnchorElement>) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const href = event.currentTarget.getAttribute("href");
  if (!href) return;
  event.preventDefault();
  navigate(href);
}

/** The store has history, but nobody did anything in the selected range. */
export function QuietRange({ range }: { range: RangeKey }) {
  const info = rangeInfo(range);
  const wider = RANGES.filter((r) => RANGES.findIndex((x) => x.key === r.key) > RANGES.findIndex((x) => x.key === range));
  return (
    <section className="state state-quiet" aria-labelledby="quiet-title">
      <Snout className="snout-big" />
      <h2 id="quiet-title">Zero activity {info.phrase}</h2>
      <p>Not a single request in this window, so the podium stays empty. Either everyone is writing code by hand or the Wi-Fi died.</p>
      {wider.length > 0 ? (
        <p className="state-links">
          Widen the investigation:{" "}
          {wider.map((r) => (
            <a key={r.key} className="btn btn-small" href={hrefFor({ range: r.key })} onClick={go}>
              {r.label}
            </a>
          ))}
        </p>
      ) : null}
    </section>
  );
}
