// Provider & model bang-for-buck comparison: subsidization ratio (API list $ per $1 real
// subscription spend), effective token pricing, output tokens per dollar, and typical thread cost.

import type { Board, ModelRow, ProviderEconomics } from "../shared/api.ts";
import { Cutout } from "./art.tsx";
import { providerLabel, rangeInfo } from "./data.ts";
import { compact, full, pct, usd } from "./format.ts";
import { SectionHead } from "./ui.tsx";

function fmtMult(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "–";
  if (n >= 100) return `${Math.round(n)}×`;
  return `${n.toFixed(1)}×`;
}

function fmtPerMillion(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "–";
  if (n < 0.01) return "<$0.01";
  if (n < 1) return `$${n.toFixed(3)}`;
  if (n < 100) return `$${n.toFixed(2)}`;
  return usd(n);
}

const CARD_FILLS = ["lime", "purple", "white"] as const;

function ProviderCard({
  row,
  index,
  maxMult,
  bestSubsidyProvider,
  bestOutputProvider,
  isSub,
}: {
  row: ProviderEconomics;
  index: number;
  maxMult: number;
  bestSubsidyProvider: string | null;
  bestOutputProvider: string | null;
  isSub: boolean;
}) {
  const fill = CARD_FILLS[index % CARD_FILLS.length]!;
  const label = providerLabel(row.provider);
  const barPct =
    row.subsidyMultiplier !== null && maxMult > 0
      ? Math.max(4, Math.min(100, (row.subsidyMultiplier / maxMult) * 100))
      : 0;
  const isSubsidyLeader = bestSubsidyProvider === row.provider && row.subsidyMultiplier !== null;
  const isOutputLeader = bestOutputProvider === row.provider && row.outputTokensPerSubDollar !== null;

  return (
    <article
      className={`econ-card wonk fill-${fill}`}
      data-provider={row.provider}
      aria-label={`${label} bang-for-buck`}
    >
      <header className="econ-card-head">
        <span className="econ-provider">
          <span className="provider-dot" aria-hidden="true" />
          <h3>{label}</h3>
        </span>
        <div className="econ-badges">
          {isSubsidyLeader ? <span className="econ-badge">Most subsidised</span> : null}
          {isOutputLeader && !isSubsidyLeader ? <span className="econ-badge">Most out / $</span> : null}
        </div>
      </header>

      <div className="econ-hero">
        {isSub && row.subsidyMultiplier !== null ? (
          <>
            <b
              className="econ-mult"
              title="Public API list dollars received per $1 of real subscription spend (measured strictly over events with both prices)"
            >
              {fmtMult(row.subsidyMultiplier)}
            </b>
            <span className="econ-mult-label">API $ per sub $</span>
          </>
        ) : row.listCostUsd !== null ? (
          <>
            <b className="econ-mult">{usd(row.listCostUsd)}</b>
            <span className="econ-mult-label">API list value</span>
          </>
        ) : (
          <>
            <b className="econ-mult is-muted">unpriced</b>
            <span className="econ-mult-label">No list price match</span>
          </>
        )}
      </div>

      {isSub && row.subsidyMultiplier !== null ? (
        <div className="econ-meter" aria-hidden="true">
          <i style={{ width: `${barPct}%` }} />
        </div>
      ) : null}

      <dl className="econ-stats">
        <div>
          <dt>{isSub ? "Real vs list" : "List value"}</dt>
          <dd>
            {isSub ? (
              row.subCostUsd !== null ? (
                <>
                  <b>{usd(row.subCostUsd)}</b>
                  <small>{row.listCostUsd !== null ? `vs ${usd(row.listCostUsd)} list` : "list unpriced"}</small>
                </>
              ) : (
                <b className="is-muted">unmetered</b>
              )
            ) : (
              <b>{row.listCostUsd !== null ? usd(row.listCostUsd) : "unpriced"}</b>
            )}
          </dd>
        </div>

        <div>
          <dt>API $ / full week</dt>
          <dd title="Public API list value delivered per 100% of one weekly quota window">
            <b>{row.apiUsdPerQuotaWeek !== null ? `${usd(row.apiUsdPerQuotaWeek)}` : "–"}</b>
            <small>{row.quotaWeeks > 0 ? `${(row.quotaWeeks * 100).toFixed(0)}% wk burned` : `${compact(row.requests)} reqs`}</small>
          </dd>
        </div>

        <div>
          <dt>Effective rate</dt>
          <dd title="Real subscription USD per 1M weighted effective tokens (in + 0.1×cacheRd + 1.25×cacheWr + 5×out)">
            <b>{row.subUsdPerMillionEffTokens !== null ? `${fmtPerMillion(row.subUsdPerMillionEffTokens)} / 1M` : "–"}</b>
            <small>
              {row.outputTokensPerSubDollar !== null
                ? `${compact(row.outputTokensPerSubDollar)} out / $1`
                : `${compact(row.tokens.output)} out`}
            </small>
          </dd>
        </div>

        <div>
          <dt>Typical thread</dt>
          <dd title="Median real subscription spend per thread with at least 5 non-failed requests. Thread lengths vary by workload and harness.">
            <b>{row.medianThreadSubCostUsd !== null ? `${usd(row.medianThreadSubCostUsd)} med` : "–"}</b>
            <small>
              {row.avgThreadSubCostUsd !== null
                ? `${usd(row.avgThreadSubCostUsd)} avg · ${full(row.substantialThreads)} threads`
                : `${full(row.threads)} ${row.threads === 1 ? "thread" : "threads"} · ${pct(row.cacheHitRate)} cache`}
            </small>
          </dd>
        </div>
      </dl>
    </article>
  );
}

function ModelEconRow({ m }: { m: ModelRow }) {
  const realPerMEff =
    m.costUsd !== null && m.costUsd > 0 && m.effectiveTokens > 0
      ? (m.costUsd / m.effectiveTokens) * 1e6
      : null;
  const outPerDollar =
    m.costUsd !== null && m.costUsd > 0 && m.tokens.output > 0
      ? m.tokens.output / m.costUsd
      : null;

  return (
    <tr className="econ-model-row" data-provider={m.provider.toLowerCase()}>
      <td className="econ-m-name">
        <span className="provider-dot" aria-hidden="true" />
        <span>
          <strong>{m.displayName}</strong>
          <small>{providerLabel(m.provider)}</small>
        </span>
      </td>
      <td className="econ-m-num econ-m-mult">
        {m.subsidyMultiplier !== null ? <b>{fmtMult(m.subsidyMultiplier)}</b> : <span className="is-muted">–</span>}
      </td>
      <td className="econ-m-num">
        {realPerMEff !== null ? `${fmtPerMillion(realPerMEff)}` : <span className="is-muted">–</span>}
      </td>
      <td className="econ-m-num">
        {outPerDollar !== null ? compact(outPerDollar) : <span className="is-muted">–</span>}
      </td>
      <td className="econ-m-num">
        {m.costUsd !== null ? (
          <>
            <strong>{usd(m.costUsd)}</strong>
            {m.listCostUsd !== null ? <small> / {usd(m.listCostUsd)} list</small> : null}
          </>
        ) : (
          <span className="is-muted">unpriced</span>
        )}
      </td>
    </tr>
  );
}

export function Economics({ board }: { board: Board }) {
  const providers = board.providerEconomics;
  if (providers.length === 0) return null;

  const isSub = board.costMode === "subscription";
  const info = rangeInfo(board.range);

  const maxMult = Math.max(0, ...providers.map((p) => p.subsidyMultiplier ?? 0));
  let bestSubsidyProvider: string | null = null;
  let bestSubsidy = 0;
  let bestOutputProvider: string | null = null;
  let bestOutput = 0;
  if (providers.length >= 2) {
    for (const p of providers) {
      if (p.subsidyMultiplier !== null && p.subsidyMultiplier > bestSubsidy) {
        bestSubsidy = p.subsidyMultiplier;
        bestSubsidyProvider = p.provider;
      }
      if (p.outputTokensPerSubDollar !== null && p.outputTokensPerSubDollar > bestOutput) {
        bestOutput = p.outputTokensPerSubDollar;
        bestOutputProvider = p.provider;
      }
    }
  }

  // Show significant models (at least 10 requests or $0.05 real spend) so tiny ping models don't clutter the comparison.
  const modelRows = board.models
    .filter((m) => m.requests >= 10 || (m.costUsd !== null && m.costUsd >= 0.05))
    .slice()
    .sort((a, b) => {
      const ma = a.subsidyMultiplier ?? -1;
      const mb = b.subsidyMultiplier ?? -1;
      if (ma !== mb) return mb - ma;
      return b.tokens.total - a.tokens.total;
    })
    .slice(0, 8);

  return (
    <section className="economics panel has-art" aria-labelledby="economics-title">
      <Cutout name="coin-stack" className="panel-art" />
      <SectionHead
        id="economics-title"
        title="Bang for"
        mark="buck"
        note={
          isSub
            ? `How much API list value each flat subscription delivered ${info.phrase}, plus effective token cost and typical thread spend.`
            : `Public API list value by provider ${info.phrase}. Configure subscriptions to see subsidization multipliers.`
        }
      />

      <div className="econ-cards">
        {providers.map((row, i) => (
          <ProviderCard
            key={row.provider}
            row={row}
            index={i}
            maxMult={maxMult}
            bestSubsidyProvider={bestSubsidyProvider}
            bestOutputProvider={bestOutputProvider}
            isSub={isSub}
          />
        ))}
      </div>

      {isSub && modelRows.length >= 2 ? (
        <div className="econ-table-wrap">
          <table className="econ-table" aria-label="Per-model bang-for-buck breakdown">
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col" className="econ-m-num" title="API list USD delivered per $1 of real subscription spend">
                  Subsidy
                </th>
                <th scope="col" className="econ-m-num" title="Real subscription USD per 1M weighted effective tokens">
                  Real / 1M eff
                </th>
                <th scope="col" className="econ-m-num" title="Output tokens delivered per $1 of real subscription spend">
                  Out tok / $1
                </th>
                <th scope="col" className="econ-m-num">
                  Sub / API list
                </th>
              </tr>
            </thead>
            <tbody>
              {modelRows.map((m) => (
                <ModelEconRow key={m.model} m={m} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
