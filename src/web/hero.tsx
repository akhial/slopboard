// Headline numbers for the whole team: the big total with its split, and a row of tiles.

import type { Board } from "../shared/api.ts";
import { colourOf, initials } from "./colors.ts";
import { rangeInfo } from "./data.ts";
import { compact, full, pct, usd } from "./format.ts";
import { Num, SplitBar, SplitLegend, Who, castOf } from "./ui.tsx";

function mood(tokensPerMinute: number): string {
  if (tokensPerMinute <= 0) return "Dead silence. Somebody might actually be typing.";
  if (tokensPerMinute < 20_000) return "Light poking. Barely warming the GPUs.";
  if (tokensPerMinute < 150_000) return "Cruising altitude. Nobody's reading the diffs.";
  if (tokensPerMinute < 600_000) return "Full industrial slop production.";
  return "Datacenter cooling fans audible from here.";
}

/** How many bars of the five-bar gauge to light, on a log scale from 1K to 10M tokens a minute. */
function gaugeLevel(tokensPerMinute: number): number {
  if (tokensPerMinute <= 0) return 0;
  return Math.max(1, Math.min(5, Math.ceil(Math.log10(tokensPerMinute) - 2)));
}

/** The complete works run to roughly 885,000 words, at about 1.3 tokens a word. */
const SHAKESPEARE = 1_180_000;

/** The big number, what it is made of, and who is to blame for it. */
export function HeroMain({ board }: { board: Board }) {
  const t = board.totals;
  const info = rangeInfo(board.range);
  const cast = castOf(board);
  const sum = board.people.reduce((s, p) => s + p.tokens.total, 0);
  const shares = board.people.filter((p) => p.tokens.total > 0).map((p) => ({ p, share: sum > 0 ? p.tokens.total / sum : 0 }));
  const shakespeares = Math.round(t.tokens.total / SHAKESPEARE);
  const cachedMostly = t.tokens.total > 0 && t.tokens.cacheRead / t.tokens.total >= 0.5;
  return (
    <section className="hero-main" aria-labelledby="hero-title">
      <h2 className="kicker" id="hero-title">
        Compute incinerated {info.phrase}
      </h2>
      <p className="hero-number">
        <Num value={t.tokens.total} />
        <span className="hero-unit">tokens</span>
      </p>
      {t.tokens.total >= SHAKESPEARE ? (
        <p className="hero-fact">
          {shakespeares <= 1 ? (
            <>That is roughly the complete works of Shakespeare, once over</>
          ) : (
            <>
              That is the complete works of Shakespeare, <b>{full(shakespeares)}</b> times over
            </>
          )}
          {cachedMostly ? " — mostly re-reading the same file from cache like it might have changed." : " — and not a single sonnet to show for it."}
        </p>
      ) : null}
      <SplitBar tokens={t.tokens} className="split-xl" />
      <SplitLegend tokens={t.tokens} />
      {shares.length > 0 ? (
        <div className="blame">
          <h3 className="kicker">Distribution of guilt</h3>
          <div className="blame-bar" role="img" aria-label={`Share of tokens: ${shares.map((s) => `${s.p.name} ${pct(s.share)}`).join(", ")}`}>
            {shares.map(({ p, share }) => (
              <i key={p.id} className={p.unassigned ? "is-ghost" : ""} style={{ flexGrow: share, background: p.unassigned ? undefined : colourOf(p.id) }} title={`${p.name}: ${pct(share)}`}>
                {share >= 0.09 && !p.unassigned ? initials(p.name) : ""}
              </i>
            ))}
          </div>
          <ul className="blame-list">
            {shares.map(({ p, share }) => (
              <li key={p.id}>
                <Who id={p.id} cast={cast} />
                <b>{pct(share)}</b>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {t.tokens.reasoning > 0 ? (
        <p className="hero-foot">
          {compact(t.tokens.reasoning)} of the output ({pct(t.tokens.output > 0 ? t.tokens.reasoning / t.tokens.output : 0)}) was the models arguing with themselves before answering.
        </p>
      ) : null}
    </section>
  );
}

export function Tiles({ board }: { board: Board }) {
  const t = board.totals;
  // The server counts the people who actually sent something. A key alone is not a mouth.
  const mouths = t.people;
  const sharedActive = board.people.some((p) => p.unassigned && p.requests > 0);
  const benched = board.people.filter((p) => !p.unassigned && p.requests === 0).length;
  const unpriced = board.models.filter((m) => !m.priced);
  const failedShare = t.requests > 0 ? t.failedRequests / t.requests : 0;
  const level = gaugeLevel(t.tokensPerMinuteNow);
  // Null means tokens without any list price. With no tokens at all it is a plain zero.
  const cost = t.costUsd === null && t.tokens.total === 0 ? 0 : t.costUsd;
  return (
    <section className="tiles" aria-label="Team numbers">
      <article className={`tile tile-live level-${level}`}>
        <h3>
          <i className="live-dot" aria-hidden="true" /> Burn rate
        </h3>
        <p className="tile-number">
          <Num value={t.tokensPerMinuteNow} />
          <span className="tile-unit">tokens / min</span>
        </p>
        <p className="tile-note">{mood(t.tokensPerMinuteNow)}</p>
        <div className="gauge" aria-hidden="true">
          {[1, 2, 3, 4, 5].map((n) => (
            <i key={n} className={n <= level ? "on" : ""} />
          ))}
        </div>
      </article>

      <article className="tile tile-price">
        <h3>Fake invoice</h3>
        <p className="tile-number">
          {cost === null ? <span className="unpriced">unpriced</span> : <Num value={cost} format={usd} />}
          <span className="stamp">not a bill</span>
        </p>
        <p className="tile-note">
          {cost === null ? "No public list price known for these models." : "API list value. Flat-rate plans mean $0 billed."}
          {t.costUsd !== null && unpriced.length > 0 ? <span title={`No public list price known for: ${unpriced.map((m) => m.displayName).join(", ")}`}> {unpriced.length} {unpriced.length === 1 ? "model" : "models"} unpriced.</span> : null}
        </p>
      </article>

      <article className="tile">
        <h3>Requests</h3>
        <p className="tile-number">
          <Num value={t.requests} />
        </p>
        <p className="tile-note">{t.failedRequests > 0 ? `${full(t.failedRequests)} went down in flames (${pct(failedShare)}).` : t.requests > 0 ? "Zero failures. Suspiciously competent." : "Not a single prompt sent."}</p>
      </article>

      <article className="tile">
        <h3>Threads</h3>
        <p className="tile-number">
          <Num value={t.threads} />
        </p>
        <p className="tile-note">{t.threads === 0 ? "Not even a warm-up chat." : t.threads === 1 ? "One thread. Still time to quit." : 'Half of them probably started with "quick question".'}</p>
      </article>

      <article className="tile">
        <h3>Subagents</h3>
        <p className="tile-number">
          <Num value={t.subagents} />
        </p>
        <p className="tile-note">{t.subagents === 0 ? "Zero interns spawned. DIY era." : t.threads > 0 ? `${(t.subagents / t.threads).toFixed(1)} unpaid interns per thread.` : "Unpaid interns deployed."}</p>
      </article>

      <article className="tile">
        <h3>Caught prompting</h3>
        <p className="tile-number">
          <Num value={mouths} format={full} />
          <span className="tile-unit">{mouths === 1 ? "person" : "people"}</span>
        </p>
        <p className="tile-note">
          {sharedActive
            ? mouths === 0
              ? "Only the mystery shared key. Nobody's confessing."
              : "Plus the mystery shared key nobody claims."
            : mouths === 0
              ? "All hands suspiciously on keyboards."
              : benched > 0
                ? `${benched} more ${benched === 1 ? "has a key and is" : "have keys and are"} pretending to be above this.`
                : "Full roster. Nobody escaped."}
        </p>
      </article>
    </section>
  );
}
