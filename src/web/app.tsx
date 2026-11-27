import { Component, useEffect } from "react";
import type { ErrorInfo, ReactNode } from "react";
import type { Board } from "../shared/api.ts";
import { Awards, Records } from "./cabinet.tsx";
import { Heatmap, Timeline } from "./charts.tsx";
import { providerLabel, rangeInfo, sameProviders, useBoard, useUrlState } from "./data.ts";
import { Guilt, HeroMain, Tiles } from "./hero.tsx";
import { Feed, Models } from "./lists.tsx";
import { Alerts, DemoBar, Footer, Masthead, PretendBill, Ticker } from "./masthead.tsx";
import { Bench, Podium, Standings } from "./ranking.tsx";
import { DayOne, Down, Loading, QuietRange } from "./states.tsx";
import { contenders } from "./ui.tsx";

/** A rendering bug should cost one section its content, not the wall monitor its whole page. */
class Guard extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("slopboard: a section failed to render", error, info.componentStack);
  }
  override componentDidUpdate(previous: { children: ReactNode }) {
    // New data may well render fine: try again on the next board.
    if (this.state.failed && previous.children !== this.props.children) this.setState({ failed: false });
  }
  override render() {
    if (this.state.failed) return <p className="panel-empty guard">This panel choked on its own data. It'll try again on the next refresh.</p>;
    return this.props.children;
  }
}

function BoardView({ board, switching }: { board: Board; switching: boolean }) {
  // Board.people lists everyone who has a key, active or not, so it says nothing about whether
  // anything happened. Day one is an empty store; quiet is a range without a single request.
  const dayOne = board.lastEventAt === null;
  const quiet = !dayOne && board.totals.requests === 0;
  const info = rangeInfo(board.range);
  return (
    <main className={switching ? "board is-switching" : "board"} aria-busy={switching}>
      {dayOne ? (
        <>
          <DayOne board={board} />
          <Guard>
            <Bench board={board} title="The suspect list" note="Keys are in circulation. Nobody has made the first move yet. One prompt takes #1." />
          </Guard>
          <Guard>
            <Awards board={board} />
          </Guard>
        </>
      ) : (
        <>
          {/* One grid, three blocks: the cards and the total on one side, the black slab of team
              numbers on the other (see .top in styles.css). */}
          <div className={quiet ? "top" : "top has-podium"}>
            {quiet ? null : (
              <Guard>
                <Podium board={board} />
              </Guard>
            )}
            <Guard>
              <HeroMain board={board} />
            </Guard>
            <Guard>
              <Tiles board={board} />
            </Guard>
          </div>
          {quiet ? (
            <>
              <QuietRange range={board.range} providers={board.providers} />
              <Guard>
                <Bench
                  board={board}
                  title="Everyone has an alibi"
                  note={
                    board.providers
                      ? `Not a single person sent a ${board.providers.map(providerLabel).join(" + ")} request ${info.phrase}.`
                      : `Not a single person sent a request ${info.phrase}.`
                  }
                />
              </Guard>
            </>
          ) : (
            <Guard>
              <Standings board={board} />
            </Guard>
          )}
          <Guard>
            <Awards board={board} />
          </Guard>
          <Guard>
            <Records board={board} />
          </Guard>
          <div className="duo">
            <Guard>
              <Timeline board={board} />
            </Guard>
            <Guard>
              <Guilt board={board} />
            </Guard>
          </div>
          <div className="duo">
            <Guard>
              <Models board={board} />
            </Guard>
            <Guard>
              <Feed board={board} />
            </Guard>
          </div>
          <div className="duo">
            <Guard>
              <Heatmap board={board} />
            </Guard>
            <PretendBill board={board} />
          </div>
        </>
      )}
    </main>
  );
}

export function App() {
  const url = useUrlState();
  const state = useBoard(url);
  const { board, error, loading } = state;
  // The tab title carries the headline, for whoever keeps the board pinned.
  const leader = board ? contenders(board)[0]?.name : undefined;
  const providerTitle = url.providers ? url.providers.map(providerLabel).join(" + ") : null;
  useEffect(() => {
    const parts = [leader ? `#1 ${leader}` : null, providerTitle, "Slopboard"].filter(Boolean);
    document.title = parts.join(" · ");
  }, [leader, providerTitle]);
  const switching = board ? board.range !== url.range || !sameProviders(board.providers, url.providers) : false;
  return (
    <div className="page">
      {url.mock ? <DemoBar url={url} /> : null}
      <Masthead url={url} state={state} />
      <Ticker board={board} down={!board && error !== null} />
      <Alerts state={state} />
      {board ? <BoardView board={board} switching={switching} /> : error ? <Down error={error} onRetry={state.refresh} loading={loading} /> : <Loading />}
      <Footer board={board} mock={url.mock} />
    </div>
  );
}
