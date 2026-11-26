// The model breakdown ("the menu") and the live feed of recent requests.

import { useEffect, useRef, useState } from "react";
import type { Board } from "../shared/api.ts";
import { rangeInfo } from "./data.ts";
import { clockFor, compact, full, pct, usd } from "./format.ts";
import { Cutout } from "./art.tsx";
import { castOf, personStyle, SectionHead, SplitBar, Who } from "./ui.tsx";

export function Models({ board }: { board: Board }) {
  const cast = castOf(board);
  const info = rangeInfo(board.range);
  const max = Math.max(1, ...board.models.map((m) => m.tokens.total));
  const sum = board.models.reduce((s, m) => s + m.tokens.total, 0);
  const isSub = board.costMode === "subscription";
  return (
    <section className="models panel has-art" aria-labelledby="models-title">
      <Cutout name="cloche" className="panel-art" />
      <SectionHead
        id="models-title"
        title="On the"
        mark="menu"
        note={
          isSub
            ? `What everyone ordered ${info.phrase}. Prices are actual subscription spend — hover for public API list rates.`
            : `What everyone ordered ${info.phrase}. Prices are public API list rates — nobody's card was charged.`
        }
      />
      {board.models.length === 0 ? (
        <p className="panel-empty">Kitchen's closed. Nothing ordered yet.</p>
      ) : (
        <ol className="menu">
          {board.models.map((m) => (
            <li key={m.model} className="dish">
              <div className="dish-head">
                <h3>{m.displayName}</h3>
                <span className="dish-dots" aria-hidden="true" />
                {m.priced && m.costUsd !== null ? (
                  <b
                    className="dish-price"
                    title={
                      isSub
                        ? m.listCostUsd !== null
                          ? `Actual subscription spend (${usd(m.listCostUsd)} at public API list rates)`
                          : "Actual subscription spend"
                        : "Public API list value (not billed)"
                    }
                  >
                    {usd(m.costUsd)}
                  </b>
                ) : (
                  <b
                    className="dish-price unpriced"
                    title={
                      isSub
                        ? "No subscription quota data for this model — not the same as free."
                        : "No public list price known for this model — not the same as free."
                    }
                  >
                    unpriced
                  </b>
                )}
              </div>
              <div className="dish-bar">
                <span style={{ width: `${Math.max(1.5, (m.tokens.total / max) * 100)}%` }}>
                  <SplitBar tokens={m.tokens} />
                </span>
                <b title={full(m.tokens.total)}>{compact(m.tokens.total)}</b>
              </div>
              <p className="dish-meta">
                <span className="tag">{m.provider}</span>
                <code>{m.model}</code>
                <span>{sum > 0 ? pct(m.tokens.total / sum) : "–"} share</span>
                <span>
                  {compact(m.requests)} {m.requests === 1 ? "request" : "requests"}
                </span>
                {m.topPersonId ? (
                  <span>
                    main culprit: <Who id={m.topPersonId} cast={cast} />
                  </span>
                ) : null}
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

const COLLAPSED = 11;

export function Feed({ board }: { board: Board }) {
  const cast = castOf(board);
  const clock = clockFor(board.timezone);
  const [open, setOpen] = useState(false);
  const seen = useRef<Set<string> | null>(null);
  const generated = new Date(board.generatedAt).getTime();

  // Events carry no id, so identify them by their content; identical twins get a counter.
  const counts = new Map<string, number>();
  const events = board.recent.map((e) => {
    const base = `${e.at}|${e.personId}|${e.model}|${e.totalTokens}`;
    const nth = counts.get(base) ?? 0;
    counts.set(base, nth + 1);
    return { e, key: `${base}|${nth}` };
  });
  const keys = events.map((x) => x.key).join("\n");
  const previous = seen.current;
  useEffect(() => {
    seen.current = new Set(keys.split("\n"));
  }, [keys]);

  const shown = open ? events : events.slice(0, COLLAPSED);
  return (
    <section className="feed slab has-art" aria-labelledby="feed-title">
      <Cutout name="telephone" className="panel-art" />
      <SectionHead id="feed-title" title="Live" mark="wiretap" note="Every request as it hits the proxy, newest first. Nowhere to hide." />
      {events.length === 0 ? (
        <p className="panel-empty">Nothing on the wire yet. Go on, ask it to rewrite the whole codebase.</p>
      ) : (
        <ol className="feed-list">
          {shown.map(({ e, key }) => {
            const old = generated - new Date(e.at).getTime() > 20 * 3_600_000;
            return (
              <li key={key} className={`feed-item ${previous && !previous.has(key) ? "is-fresh" : ""} ${e.failed ? "is-failed" : ""}`} style={personStyle(e.personId)}>
                <time dateTime={e.at} title={clock.stamp(e.at)}>
                  {old ? clock.dayTime(e.at) : clock.timeSec(e.at)}
                </time>
                <Who id={e.personId} cast={cast} />
                <span className="feed-model" title={e.model}>
                  {e.modelName || e.model}
                  {e.subagent ? <span className="tag tag-sub">subagent</span> : null}
                  {e.failed ? <span className="tag tag-bad">failed</span> : null}
                </span>
                <b className="feed-tokens" title={`${full(e.totalTokens)} tokens`}>
                  {e.failed && e.totalTokens === 0 ? "–" : compact(e.totalTokens)}
                </b>
                <span className={`feed-cost ${e.costUsd === null ? "unpriced" : ""}`}>{e.costUsd === null ? "unpriced" : e.failed && e.totalTokens === 0 ? "" : usd(e.costUsd)}</span>
              </li>
            );
          })}
        </ol>
      )}
      {events.length > COLLAPSED ? (
        <button type="button" className="more" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? "Show fewer" : `Show all ${events.length} requests`}
        </button>
      ) : null}
    </section>
  );
}
