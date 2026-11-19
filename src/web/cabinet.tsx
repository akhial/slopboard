// Awards and records: titles, emoji, blurbs and values all come from the server.

import type { Board } from "../shared/api.ts";
import { rangeInfo } from "./data.ts";
import { clockFor } from "./format.ts";
import { Avatar, castOf, personStyle, SectionHead, Who } from "./ui.tsx";

export function Awards({ board }: { board: Board }) {
  if (board.awards.length === 0) return null;
  const cast = castOf(board);
  const info = rangeInfo(board.range);
  const claimed = board.awards.filter((a) => a.winnerId).length;
  return (
    <section className="cabinet" aria-labelledby="awards-title">
      <SectionHead
        id="awards-title"
        title="Trophy"
        mark="cabinet"
        note={
          claimed > 0
            ? `${claimed} of ${board.awards.length} handed out ${info.phrase}. Awarded by SQL, appealed in group chat.`
            : `${board.awards.length} medals, zero takers. Nobody has embarrassed themselves enough yet.`
        }
      />
      <ul className="trophies">
        {board.awards.map((a) => {
          const winner = cast.get(a.winnerId);
          const vacant = !a.winnerId;
          return (
            <li key={a.id} className={`trophy ${vacant ? "is-vacant" : ""}`} style={personStyle(a.winnerId)}>
              <div className="trophy-top">
                <span className="medal" aria-hidden="true">
                  <span className="emoji">{a.emoji}</span>
                </span>
                <h3>{a.title}</h3>
              </div>
              <p className="trophy-blurb">{a.blurb}</p>
              {vacant ? (
                <p className="plaque plaque-vacant">
                  <span className="plaque-name">Unclaimed</span>
                  <span className="plaque-value">{claimed > 0 ? `Nobody hit the bar ${info.phrase}` : "Waiting for our first offender"}</span>
                </p>
              ) : (
                <p className="plaque">
                  <Avatar id={a.winnerId ?? ""} name={cast.name(a.winnerId)} ghost={winner?.unassigned} />
                  <span className="plaque-text">
                    <span className="plaque-name">{cast.name(a.winnerId)}</span>
                    {a.value ? <span className="plaque-value">{a.value}</span> : null}
                  </span>
                </p>
              )}
              <p className="trophy-runner">
                {a.runnerUpId && !vacant ? (
                  <>
                    Close behind: <Who id={a.runnerUpId} cast={cast} />
                  </>
                ) : vacant ? (
                  "One bad afternoon away."
                ) : (
                  "Uncontested. Nobody even tried."
                )}
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function Records({ board }: { board: Board }) {
  if (board.records.length === 0) return null;
  const cast = castOf(board);
  const clock = clockFor(board.timezone);
  const info = rangeInfo(board.range);
  return (
    <section className="records-section" aria-labelledby="records-title">
      <SectionHead id="records-title" title="Permanent" mark="record" note={`Individual feats of excess: one thread, one prompt, one hour. Worst offences ${info.phrase}.`} />
      <ul className="records">
        {board.records.map((r, i) => (
          <li key={r.id} className="record" style={personStyle(r.personId)}>
            <div className="record-stub" aria-hidden="true">
              <span className="emoji">{r.emoji}</span>
              <span className="record-no">EX. {String(i + 1).padStart(2, "0")}</span>
            </div>
            <div className="record-body">
              <h3>{r.title}</h3>
              <p className="record-value">{r.value}</p>
              <p className="record-detail">{r.detail}</p>
              <p className="record-holder">
                {r.personId ? <Who id={r.personId} cast={cast} /> : <span className="who is-team">Group effort</span>}
                {r.at ? <time dateTime={r.at}>{clock.date(r.at)}</time> : null}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
