// What the page shows when there is no board to show, or nothing on it.

import type { MouseEvent } from "react";
import type { Board, RangeKey } from "../shared/api.ts";
import { hrefFor, navigate, rangeInfo, RANGES } from "./data.ts";
import { Cutout, Doodle } from "./art.tsx";

export function Loading() {
  return (
    <main className="state state-loading" aria-busy="true">
      <Cutout name="pig" className="state-art is-sniffing" />
      <h2>
        Auditing the <em className="scrawl">slop…</em>
      </h2>
      <p>Pulling everyone's receipts.</p>
    </main>
  );
}

export function Down({ error, onRetry, loading }: { error: string; onRetry: () => void; loading: boolean }) {
  return (
    <main className="state state-down">
      <div className="state-art-wrap" aria-hidden="true">
        <Cutout name="telephone" className="state-art" />
        <Doodle name="ticks" className="state-ticks" />
      </div>
      <h2>
        The board has <em className="scrawl">flatlined</em>
      </h2>
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
      <div className="state-art-wrap" aria-hidden="true">
        <Cutout name="melting-smiley" className="state-art" />
        <Doodle name="ticks" className="state-ticks" />
      </div>
      <h2 id="empty-title">
        Clean slate. <em className="scrawl">Suspiciously clean.</em>
      </h2>
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
      <div className="state-art-wrap" aria-hidden="true">
        <Cutout name="alarm-clock" className="state-art" />
        <Doodle name="ticks" className="state-ticks" />
      </div>
      <h2 id="quiet-title">
        Zero activity <em className="scrawl">{info.phrase}</em>
      </h2>
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
