import { useState } from 'react';
import { Search } from 'lucide-react';
import type { BotStateSnapshot, StrategyConfig, StrategyId } from '../shared/types';
import { formatInr, formatSignedInr, formatSignedPct } from '../utils/format';

interface StrategiesViewProps {
  state: BotStateSnapshot;
  onUpdateStrategy: (
    id: StrategyId,
    updates: Partial<
      Pick<
        StrategyConfig,
        'enabled' | 'capitalWeightPct' | 'minConfidence' | 'stopLossAtrMult' | 'targetAtrMult'
      >
    >
  ) => void;
}

export function StrategiesView({ state, onUpdateStrategy }: StrategiesViewProps) {
  const [search, setSearch] = useState('');
  const [signalOnly, setSignalOnly] = useState(false);

  const filteredTickers = state.tickers.filter((t) => {
    const matchesSearch =
      t.symbol.toLowerCase().includes(search.toLowerCase()) ||
      t.sector.toLowerCase().includes(search.toLowerCase());
    const matchesSignal = !signalOnly || t.signal !== null;
    return matchesSearch && matchesSignal;
  });

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {state.strategies.map((strat) => {
          const winRate =
            strat.tradesCount > 0 ? (strat.winCount / strat.tradesCount) * 100 : 0;
          return (
            <div
              key={strat.id}
              className="bg-[#0C121D] border border-slate-800 rounded p-4 flex flex-col justify-between"
            >
              <div>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-100">{strat.name}</h3>
                    <div className="text-[11px] font-mono text-slate-400 mt-0.5">{strat.id}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onUpdateStrategy(strat.id, { enabled: !strat.enabled })}
                    className={`px-2.5 py-1 rounded text-xs font-mono transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      strat.enabled
                        ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                        : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                    }`}
                  >
                    {strat.enabled ? 'ACTIVE' : 'DISABLED'}
                  </button>
                </div>

                <p className="mt-2.5 text-xs text-slate-400 leading-relaxed">
                  {strat.description}
                </p>
              </div>

              <div className="mt-4 pt-3 border-t border-slate-800 space-y-3">
                <div className="grid grid-cols-3 gap-2 text-xs font-mono tabular-nums">
                  <div>
                    <div className="text-slate-400 font-sans text-[11px]">Trades</div>
                    <div className="font-semibold text-slate-100 mt-0.5">
                      {strat.tradesCount}
                    </div>
                  </div>
                  <div>
                    <div className="text-slate-400 font-sans text-[11px]">Win Rate</div>
                    <div className="font-semibold text-slate-100 mt-0.5">
                      {winRate.toFixed(1)}%
                    </div>
                  </div>
                  <div>
                    <div className="text-slate-400 font-sans text-[11px]">Net PnL</div>
                    <div
                      className={`font-semibold mt-0.5 ${
                        strat.netPnlInr >= 0 ? 'text-emerald-400' : 'text-rose-400'
                      }`}
                    >
                      {formatSignedInr(strat.netPnlInr)}
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 text-xs">
                  <label className="block">
                    <span className="text-slate-400 text-[11px]">Min Confidence</span>
                    <input
                      type="number"
                      min={40}
                      max={95}
                      value={strat.minConfidence}
                      onChange={(e) =>
                        onUpdateStrategy(strat.id, {
                          minConfidence: Number(e.target.value) || 60,
                        })
                      }
                      className="mt-1 w-full px-2.5 py-1.5 border border-slate-700 rounded font-mono tabular-nums text-slate-100 bg-[#070B12]"
                    />
                  </label>
                  <label className="block">
                    <span className="text-slate-400 text-[11px]">Target / Stop ATR</span>
                    <div className="mt-1 flex items-center gap-1.5">
                      <input
                        type="number"
                        step="0.1"
                        min={0.5}
                        max={5}
                        value={strat.targetAtrMult}
                        onChange={(e) =>
                          onUpdateStrategy(strat.id, {
                            targetAtrMult: Number(e.target.value) || 1.8,
                          })
                        }
                        className="w-full px-2 py-1.5 border border-slate-700 rounded font-mono tabular-nums text-slate-100 bg-[#070B12]"
                      />
                      <span className="text-slate-600">/</span>
                      <input
                        type="number"
                        step="0.1"
                        min={0.5}
                        max={3}
                        value={strat.stopLossAtrMult}
                        onChange={(e) =>
                          onUpdateStrategy(strat.id, {
                            stopLossAtrMult: Number(e.target.value) || 1.0,
                          })
                        }
                        className="w-full px-2 py-1.5 border border-slate-700 rounded font-mono tabular-nums text-slate-100 bg-[#070B12]"
                      />
                    </div>
                  </label>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="bg-[#0C121D] border border-slate-800 rounded overflow-hidden">
        <div className="px-4 py-3.5 border-b border-slate-800 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">
              NIFTY 50 Universe &amp; Real-Time Signal Scanner
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              ₹10,000 capital filter prioritizes liquid NSE stocks where Upstox round-trip fees stay well below expected ATR target profit.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Filter symbol or sector..."
                className="pl-8 pr-3 py-1.5 text-xs border border-slate-700 rounded bg-[#070B12] text-slate-100 focus:outline-none focus:border-slate-500"
              />
            </div>
            <button
              type="button"
              onClick={() => setSignalOnly(!signalOnly)}
              className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                signalOnly
                  ? 'bg-emerald-500 text-slate-950'
                  : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
              }`}
            >
              {signalOnly ? 'Signals Only' : 'All 12 Stocks'}
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-800 bg-[#090E17] text-slate-400 font-medium">
                <th className="py-2.5 px-4">Symbol</th>
                <th className="py-2.5 px-3">Sector</th>
                <th className="py-2.5 px-3 text-right">LTP</th>
                <th className="py-2.5 px-3 text-right">Change</th>
                <th className="py-2.5 px-3 text-right">VWAP</th>
                <th className="py-2.5 px-3 text-right">ATR-14</th>
                <th className="py-2.5 px-3 text-right">RSI-14</th>
                <th className="py-2.5 px-3 text-right">Z-Score</th>
                <th className="py-2.5 px-3 text-right">RVOL</th>
                <th className="py-2.5 px-4 text-right">Signal</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {filteredTickers.map((t) => {
                const ticketTooLarge =
                  t.ltp >
                  state.currentEquityInr *
                    (state.guardrails.maxSingleStockWeightPct / 100);
                return (
                  <tr key={t.symbol} className="hover:bg-slate-800/30 transition-colors">
                    <td className="py-2.5 px-4 font-semibold text-slate-100">
                      {t.symbol}
                      {ticketTooLarge && (
                        <span className="ml-2 text-[10px] font-mono font-normal text-amber-400">
                          &gt; CAP
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 px-3 text-slate-400">{t.sector}</td>
                    <td className="py-2.5 px-3 text-right font-mono tabular-nums font-medium text-slate-100">
                      {formatInr(t.ltp)}
                    </td>
                    <td
                      className={`py-2.5 px-3 text-right font-mono tabular-nums ${
                        t.changePct >= 0 ? 'text-emerald-400' : 'text-rose-400'
                      }`}
                    >
                      {formatSignedPct(t.changePct)}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-300">
                      {formatInr(t.vwap)}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-300">
                      {t.atr14.toFixed(2)}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-200">
                      {t.rsi14.toFixed(1)}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-200">
                      {t.zScore.toFixed(2)}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-200">
                      {t.rvol.toFixed(2)}x
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono">
                      {t.signal ? (
                        <span
                          className={
                            t.signalSide === 'BUY'
                              ? 'text-emerald-400 font-semibold'
                              : 'text-rose-400 font-semibold'
                          }
                        >
                          {t.signalSide} · {t.signal} ({t.signalConfidence}%)
                        </span>
                      ) : (
                        <span className="text-slate-500">Neutral</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
