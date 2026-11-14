import { useState } from 'react';
import { FlaskConical } from 'lucide-react';
import type { BacktestResult } from '../shared/types';
import { formatInr, formatSignedInr, formatSignedPct } from '../utils/format';
import { EquityCurveChart } from './EquityCurveChart';

interface BacktestViewProps {
  onRunBacktest: (days: number) => Promise<{ ok: boolean; result?: BacktestResult; error?: string }>;
}

export function BacktestView({ onRunBacktest }: BacktestViewProps) {
  const [days, setDays] = useState(60);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BacktestResult | null>(null);

  const handleRun = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await onRunBacktest(days);
      if (!res.ok || !res.result) {
        setError(res.error || 'Upstox historical backtest failed.');
      } else {
        setResult(res.result);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="bg-[#0C121D] border border-slate-800 rounded p-5">
        <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-slate-800">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">
              Upstox V3 Historical NSE Candle Stress-Test
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Fetches real NSE daily candles directly from Upstox V3 API and replays your ₹10,000
              survival guardrails &amp; statutory fees. Zero simulated prices.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <select
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              className="px-3 py-2 text-xs border border-slate-700 rounded font-mono bg-[#070B12] text-slate-100"
            >
              <option value={30}>Last 30 Days</option>
              <option value={60}>Last 60 Days</option>
              <option value={90}>Last 90 Days</option>
              <option value={180}>Last 180 Days</option>
            </select>
            <button
              type="button"
              onClick={handleRun}
              disabled={loading}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-slate-950 bg-emerald-400 hover:bg-emerald-300 disabled:opacity-50 rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <FlaskConical className="w-3.5 h-3.5" />
              {loading ? 'Fetching Candles...' : 'Run Real-Data Backtest'}
            </button>
          </div>
        </div>

        {error && (
          <div className="mt-4 p-3 bg-amber-950/60 border border-amber-500/40 rounded text-xs text-amber-200">
            {error}
          </div>
        )}
      </div>

      {result ? (
        <div className="space-y-4">
          <div
            className={`rounded border px-4 py-3 flex flex-wrap items-center justify-between gap-3 ${
              result.survived
                ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-200'
                : 'bg-rose-950/50 border-rose-500/40 text-rose-200'
            }`}
          >
            <div className="text-xs">
              <span className="font-semibold font-mono">
                {result.survived ? 'SURVIVED FULL HORIZON' : 'SURVIVAL FLOOR BREACHED'}
              </span>
              <span className="mx-2">·</span>
              <span>{result.survivalStatusReason}</span>
            </div>
            <div className="text-xs font-mono tabular-nums">
              {result.daysSimulated} trading days · {result.totalTrades} trades ·{' '}
              {result.rejectedByRiskCount} risk-blocked
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-[#0C121D] border border-slate-800 rounded p-4">
              <div className="text-[11px] text-slate-400">Ending Equity (Net)</div>
              <div
                className={`mt-1.5 text-xl font-bold font-mono tabular-nums ${
                  result.endingCapitalInr >= result.startingCapitalInr
                    ? 'text-emerald-400'
                    : 'text-rose-400'
                }`}
              >
                {formatInr(result.endingCapitalInr)}
              </div>
              <div className="mt-1 text-xs font-mono text-slate-400">
                {formatSignedPct(result.netReturnPct)} from {formatInr(result.startingCapitalInr, true)}
              </div>
            </div>

            <div className="bg-[#0C121D] border border-slate-800 rounded p-4">
              <div className="text-[11px] text-slate-400">Max Drawdown Observed</div>
              <div className="mt-1.5 text-xl font-bold font-mono tabular-nums text-slate-100">
                {result.maxDrawdownPct.toFixed(2)}%
              </div>
              <div className="mt-1 text-xs font-mono text-rose-400">
                Survival Floor {formatInr(result.survivalFloorInr)}
              </div>
            </div>

            <div className="bg-[#0C121D] border border-slate-800 rounded p-4">
              <div className="text-[11px] text-slate-400">Sharpe &amp; Profit Factor</div>
              <div className="mt-1.5 text-xl font-bold font-mono tabular-nums text-slate-100">
                {result.sharpeRatio.toFixed(2)} / {result.profitFactor.toFixed(2)}
              </div>
              <div className="mt-1 text-xs font-mono text-slate-400">
                Win Rate {result.winRatePct.toFixed(1)}%
              </div>
            </div>

            <div className="bg-[#0C121D] border border-slate-800 rounded p-4">
              <div className="text-[11px] text-slate-400">Total Upstox Taxes &amp; Fees</div>
              <div className="mt-1.5 text-xl font-bold font-mono tabular-nums text-amber-400">
                {formatInr(result.totalStatutoryChargesInr)}
              </div>
              <div className="mt-1 text-xs font-mono text-slate-400">
                {result.dataSource}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
            <div className="lg:col-span-7 bg-[#0C121D] border border-slate-800 rounded p-4">
              <h3 className="text-sm font-semibold text-slate-100 mb-3">
                Historical Equity vs Survival Floor
              </h3>
              <EquityCurveChart points={result.equityCurve} height={240} />
            </div>

            <div className="lg:col-span-5 bg-[#0C121D] border border-slate-800 rounded overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-800">
                <h3 className="text-sm font-semibold text-slate-100">
                  Strategy Expectancy Attribution
                </h3>
              </div>
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-800 bg-[#090E17] text-slate-400">
                    <th className="py-2.5 px-4">Strategy</th>
                    <th className="py-2.5 px-3 text-right">Trades</th>
                    <th className="py-2.5 px-3 text-right">Win %</th>
                    <th className="py-2.5 px-4 text-right">Net PnL</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70">
                  {result.strategyBreakdown.map((s) => (
                    <tr key={s.strategyId}>
                      <td className="py-3 px-4 font-medium text-slate-200">{s.name}</td>
                      <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-300">
                        {s.trades}
                      </td>
                      <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-300">
                        {s.winRatePct.toFixed(1)}%
                      </td>
                      <td
                        className={`py-3 px-4 text-right font-mono font-semibold tabular-nums ${
                          s.netPnlInr >= 0 ? 'text-emerald-400' : 'text-rose-400'
                        }`}
                      >
                        {formatSignedInr(s.netPnlInr)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : (
        <div className="bg-[#0C121D] border border-slate-800 rounded p-10 text-center text-xs text-slate-400">
          Click <span className="text-emerald-400 font-medium">Run Real-Data Backtest</span> to
          replay your ₹10,000 guardrails against real NSE historical candles from Upstox V3 API.
        </div>
      )}
    </div>
  );
}
