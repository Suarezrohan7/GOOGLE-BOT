import { useState } from 'react';
import { ArrowRight, Brain, RefreshCw, ShieldAlert } from 'lucide-react';
import type { BotStateSnapshot } from '../shared/types';
import { formatInr, formatSignedInr, formatSignedPct, formatTimeShort } from '../utils/format';
import { AlphaScatterPlot } from './AlphaScatterPlot';
import { EquityCurveChart } from './EquityCurveChart';

interface OverviewViewProps {
  state: BotStateSnapshot;
  aiLoading: boolean;
  aiError: string | null;
  onRunAiSupervisor: () => void;
  onToggleAiAutoApply: (enabled: boolean) => void;
  onSyncUpstox: () => Promise<string | null>;
}

export function OverviewView({
  state,
  aiLoading,
  aiError,
  onRunAiSupervisor,
  onToggleAiAutoApply,
  onSyncUpstox,
}: OverviewViewProps) {
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState<string | null>(null);

  const handleQuickSync = async () => {
    setSyncing(true);
    setSyncNote(null);
    const err = await onSyncUpstox();
    if (err) {
      setSyncNote(err);
    }
    setSyncing(false);
  };
  const netReturnPct =
    state.initialCapitalInr > 0
      ? ((state.currentEquityInr - state.initialCapitalInr) / state.initialCapitalInr) * 100
      : 0;
  const totalNetPnl = state.currentEquityInr - state.initialCapitalInr;
  const maxDailyLossInr =
    state.guardrails.allocatedCapitalInr * (state.guardrails.maxDailyLossPct / 100);
  const maxTicketInr =
    state.currentEquityInr * (state.guardrails.maxSingleStockWeightPct / 100);

  const liveTickersCount = state.tickers.filter((t) => t.ltp > 0).length;
  const activeSignalsCount = state.tickers.filter((t) => t.signal !== null).length;
  const approvedAudits = state.riskAudit.filter((r) => r.decision === 'APPROVED').length;
  const blockedAudits = state.riskAudit.filter(
    (r) => r.decision === 'REJECTED' || r.decision === 'THROTTLED'
  ).length;

  const pipelineStages = [
    {
      label: '01. Upstox Live Feed',
      metric: state.upstoxConnected
        ? `${liveTickersCount}/12 NSE Synced`
        : 'Awaiting Token',
      sub:
        state.upstoxLiveBalanceInr !== null
          ? `Upstox Bal ${formatInr(state.upstoxLiveBalanceInr)}`
          : 'v2/v3 Market Quotes',
      active: state.upstoxConnected,
    },
    {
      label: '02. Signal Scanner',
      metric: `${activeSignalsCount} Active / 12 NSE`,
      sub: 'ORB · Z-Score · Pairs',
      active: activeSignalsCount > 0,
    },
    {
      label: '03. 11-Gate Long-Only Risk',
      metric: `${approvedAudits} Pass · ${blockedAudits} Cut`,
      sub: `BUY Only · ${state.guardrails.riskPerTradePct}% Stop`,
      active: state.status === 'RUNNING',
    },
    {
      label: '04. Quant Regime Desk',
      metric: state.aiSupervisor
        ? `${state.aiSupervisor.regimeAssessment} (${state.aiThrottleMultiplier}x)`
        : 'Auto 60s Cadence',
      sub: state.aiSupervisor
        ? `${state.aiSupervisor.vetoedSymbols.length} Vetoed · No Key Needed`
        : 'Built-in Deterministic',
      active: Boolean(state.aiSupervisor),
    },
    {
      label: '05. Upstox HFT Router',
      metric: state.upstoxConnected ? 'LIVE MONEY ARMED' : 'LOCKED (NO TOKEN)',
      sub: `${state.positions.length}/${state.guardrails.maxOpenPositions} Active Slot`,
      active: state.positions.length > 0,
    },
  ];

  const sectorRows = Array.from(new Set(state.tickers.map((t) => t.sector))).map((sector) => {
    const stocks = state.tickers.filter((t) => t.sector === sector);
    const avgChg = stocks.reduce((acc, s) => acc + s.changePct, 0) / stocks.length;
    const signals = stocks.filter((s) => s.signal !== null).length;
    const openPos = state.positions.filter((p) => p.sector === sector);
    const openPnl = openPos.reduce((acc, p) => acc + p.unrealizedPnlInr, 0);
    return { sector, count: stocks.length, avgChg, signals, openCount: openPos.length, openPnl };
  });

  return (
    <div className="space-y-4">
      {/* Status Banner for Token / Closed / Breaker States */}
      {state.status !== 'RUNNING' && (
        <div
          className={`rounded border px-4 py-3 flex flex-wrap items-center justify-between gap-3 ${
            state.status === 'DEADMAN_LOCK' || state.status === 'HALTED_DAILY_LOSS'
              ? 'bg-rose-950/60 border-rose-500/40 text-rose-200'
              : 'bg-amber-950/40 border-amber-500/30 text-amber-200'
          }`}
        >
          <div className="flex items-start gap-3">
            <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
            <div className="text-xs">
              <span className="font-semibold font-mono">{state.status}: </span>
              {state.statusReason}
            </div>
          </div>
          {state.status === 'AWAITING_UPSTOX_TOKEN' && state.upstoxOAuthConfigured && (
            <a
              href="/api/upstox/login"
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-1.5 text-xs font-medium bg-emerald-400 hover:bg-emerald-300 text-slate-950 rounded transition-colors whitespace-nowrap shrink-0"
            >
              1-Tap Upstox Login
            </a>
          )}
        </div>
      )}

      {/* Row 1: 3-Column Terminal Hero Row */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch">
        {/* Left: Capital & Survival Hero Card */}
        <div className="lg:col-span-3 bg-[#0C121D] border border-slate-800 rounded p-4 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between text-[11px] text-slate-400">
              <span className="font-medium text-slate-300">Upstox Live Capital</span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleQuickSync}
                  disabled={syncing}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-mono bg-slate-800 hover:bg-slate-700 text-slate-200 rounded transition-colors cursor-pointer disabled:opacity-50"
                >
                  <RefreshCw className={`w-2.5 h-2.5 ${syncing ? 'animate-spin' : ''}`} />
                  Sync
                </button>
                <span className="font-mono text-rose-400">LIVE · {state.guardrails.productType}</span>
              </div>
            </div>

            <div className="mt-3">
              {state.upstoxLiveBalanceInr === null ? (
                <>
                  <div className="text-2xl font-bold tracking-tight font-mono text-amber-300">
                    {state.upstoxConnected ? 'Funds Window Closed' : 'Token Required'}
                  </div>
                  <div className="mt-1.5 text-[11px] text-slate-400 leading-relaxed">
                    {state.upstoxConnected
                      ? 'Upstox Funds API sleeps 00:00–05:30 IST daily. Real ₹ balance auto-syncs at 05:30 IST (and every 3s live / 15s off-hours).'
                      : 'Approve WhatsApp/Upstox token prompt to pull live Upstox ₹ balance.'}
                  </div>
                </>
              ) : (
                <>
                  <div
                    className={`text-3xl font-bold tracking-tight font-mono tabular-nums ${
                      totalNetPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'
                    }`}
                  >
                    {formatInr(state.currentEquityInr)}
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-xs font-mono tabular-nums">
                    <span className={totalNetPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                      {formatSignedInr(totalNetPnl)} ({formatSignedPct(netReturnPct)})
                    </span>
                  </div>
                  <div className="mt-1 text-[11px] font-mono text-sky-400">
                    Upstox SEC Live: {formatInr(state.upstoxLiveBalanceInr)}
                  </div>
                </>
              )}
              {syncNote && (
                <div className="mt-1.5 text-[10px] font-mono text-amber-300">{syncNote}</div>
              )}
            </div>

            <div className="mt-4 pt-3 border-t border-slate-800/80 space-y-2 text-xs">
              <div className="flex items-center justify-between font-mono tabular-nums">
                <span className="text-slate-400 font-sans">Buffer to Death Floor</span>
                <span
                  className={
                    state.upstoxLiveBalanceInr !== null &&
                    state.survivalFloorInr > 0 &&
                    state.survivalBufferPct <= 3
                      ? 'text-rose-400 font-semibold'
                      : 'text-emerald-400'
                  }
                >
                  {state.upstoxLiveBalanceInr === null
                    ? 'Floor ₹0'
                    : `${formatInr(state.survivalBufferInr)} (${state.survivalBufferPct.toFixed(0)}%)`}
                </span>
              </div>
              <div className="w-full h-1.5 bg-slate-800 rounded-sm overflow-hidden">
                <div
                  className={`h-full ${
                    state.upstoxLiveBalanceInr !== null &&
                    state.survivalFloorInr > 0 &&
                    state.survivalBufferPct <= 3
                      ? 'bg-rose-500'
                      : 'bg-emerald-500'
                  }`}
                  style={{
                    width:
                      state.survivalFloorInr === 0
                        ? '100%'
                        : `${Math.min(100, Math.max(4, (state.survivalBufferPct / 20) * 100))}%`,
                  }}
                />
              </div>
              <div className="flex items-center justify-between text-[11px] font-mono tabular-nums text-slate-400">
                <span>
                  {state.survivalFloorInr === 0
                    ? 'Floor ₹0 (Zero Cutoff)'
                    : `Floor ${formatInr(state.survivalFloorInr, true)}`}
                </span>
                <span>Peak {formatInr(state.peakEquityInr, true)}</span>
              </div>
            </div>
          </div>

          <div className="mt-4 pt-3 border-t border-slate-800 grid grid-cols-2 gap-3 text-xs font-mono tabular-nums">
            <div>
              <div className="text-[11px] text-slate-400 font-sans">Daily Net PnL</div>
              <div
                className={`mt-0.5 font-semibold ${
                  state.dailyPnlInr >= 0 ? 'text-emerald-400' : 'text-rose-400'
                }`}
              >
                {formatSignedInr(state.dailyPnlInr)}
              </div>
              <div className="text-[10px] text-slate-500">
                {state.guardrails.maxDailyLossPct >= 100
                  ? 'Full Comeback Allowed'
                  : `Cap -${formatInr(maxDailyLossInr, true)}`}
              </div>
            </div>

            <div>
              <div className="text-[11px] text-slate-400 font-sans">Win Rate / PF</div>
              <div className="mt-0.5 font-semibold text-slate-100">
                {state.winRatePct.toFixed(0)}% / {state.profitFactor.toFixed(2)}
              </div>
              <div className="text-[10px] text-slate-500">{state.trades.length} closed</div>
            </div>

            <div>
              <div className="text-[11px] text-slate-400 font-sans">Used Margin</div>
              <div className="mt-0.5 font-semibold text-slate-100">
                {formatInr(state.usedMarginInr, true)}
              </div>
              <div className="text-[10px] text-slate-500">
                Free {formatInr(state.availableMarginInr, true)}
              </div>
            </div>

            <div>
              <div className="text-[11px] text-slate-400 font-sans">Upstox Fees Paid</div>
              <div className="mt-0.5 font-semibold text-amber-400">
                {formatInr(state.totalChargesPaidInr)}
              </div>
              <div className="text-[10px] text-slate-500">STT + Brok + GST</div>
            </div>
          </div>
        </div>

        {/* Center: Equity Curve & Market Tape Chart */}
        <div className="lg:col-span-5 bg-[#0C121D] border border-slate-800 rounded p-4 flex flex-col justify-between">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-100">
                Equity Curve &amp; Drawdown Floor
              </h2>
              <p className="text-[11px] font-mono tabular-nums text-slate-400 mt-0.5">
                {state.session.istDateStr} · {state.session.istTimeStr} ·{' '}
                {state.session.isHoliday
                  ? `HOLIDAY (${state.session.holidayName})`
                  : state.session.isWeekend
                    ? 'WEEKEND CLOSED'
                    : state.session.phase}
              </p>
            </div>
            <span className="text-[11px] font-mono text-slate-400">
              Regime {state.session.regime}
            </span>
          </div>

          <EquityCurveChart points={state.equityCurve} height={225} />
        </div>

        {/* Right: Gemini AI Risk Supervisor */}
        <div className="lg:col-span-4 bg-[#0C121D] border border-slate-800 rounded p-4 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between gap-2 mb-3">
              <div className="flex items-center gap-2">
                <Brain className="w-4 h-4 text-sky-400" />
                <h2 className="text-sm font-semibold text-slate-100">Quant Regime Risk Desk</h2>
              </div>
              <button
                type="button"
                onClick={onRunAiSupervisor}
                disabled={aiLoading}
                className="px-2.5 py-1 text-xs font-medium text-slate-950 bg-emerald-400 hover:bg-emerald-300 disabled:opacity-50 rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                {aiLoading ? 'Evaluating...' : 'Run Audit'}
              </button>
            </div>

            <div className="flex items-center justify-between py-1.5 border-y border-slate-800 text-[11px] text-slate-400 mb-3">
              <span>Autonomous Regime Throttle (every 60s live)</span>
              <button
                type="button"
                onClick={() =>
                  onToggleAiAutoApply(!(state.aiSupervisor?.autoApplyEnabled ?? true))
                }
                className={`px-2 py-0.5 rounded font-mono text-[11px] transition-colors whitespace-nowrap cursor-pointer ${
                  state.aiSupervisor?.autoApplyEnabled !== false
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                    : 'bg-slate-800 text-slate-400'
                }`}
              >
                {state.aiSupervisor?.autoApplyEnabled !== false ? 'ENFORCED' : 'ADVISORY'}
              </button>
            </div>

            {aiError && (
              <div className="mb-2.5 p-2.5 bg-rose-950/60 border border-rose-500/40 rounded text-[11px] text-rose-200">
                {aiError}
              </div>
            )}

            {state.aiSupervisor ? (
              <div className="space-y-2.5 text-xs">
                <div className="grid grid-cols-3 gap-2 pb-2 border-b border-slate-800 font-mono tabular-nums">
                  <div>
                    <div className="text-[10px] text-slate-400 font-sans">Regime</div>
                    <div className="font-semibold text-sky-300">
                      {state.aiSupervisor.regimeAssessment}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-slate-400 font-sans">Throttle</div>
                    <div className="font-semibold text-slate-100">
                      {state.aiSupervisor.recommendedThrottle.toFixed(2)}x
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-slate-400 font-sans">Conviction</div>
                    <div className="font-semibold text-emerald-400">
                      {state.aiSupervisor.convictionScore}/100
                    </div>
                  </div>
                </div>

                <p className="text-[11px] text-slate-300 leading-relaxed">
                  {state.aiSupervisor.deskSummary}
                </p>

                <div className="text-[11px] text-slate-400 leading-relaxed">
                  <span className="text-amber-300 font-medium">Fee Check: </span>
                  {state.aiSupervisor.taxDragAssessment}
                </div>

                <div className="grid grid-cols-2 gap-2 pt-1 text-[11px] font-mono">
                  <div>
                    <span className="text-slate-500 font-sans">Cleared: </span>
                    <span className="text-emerald-400">
                      {state.aiSupervisor.approvedSymbols.join(', ') || 'None'}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-500 font-sans">Vetoed: </span>
                    <span className="text-rose-400">
                      {state.aiSupervisor.vetoedSymbols.join(', ') || 'None'}
                    </span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="py-6 text-center text-xs text-slate-400 leading-relaxed">
                Runs automatically every 60s during live NSE hours using the built-in Quant Regime
                Engine (no Gemini API key required). Click <span className="font-mono text-slate-200">Run Audit</span> anytime.
              </div>
            )}
          </div>

          <div className="mt-3 pt-2.5 border-t border-slate-800 flex items-center justify-between text-[11px] font-mono text-slate-500">
            <span>
              {state.aiSupervisor ? state.aiSupervisor.model : 'artha-quant-deterministic-v1'}
            </span>
            <span>
              {state.aiSupervisor
                ? `${formatTimeShort(state.aiSupervisor.timestamp)} IST`
                : 'Auto-armed'}
            </span>
          </div>
        </div>
      </div>

      {/* Row 2: 5-Stage Horizontal Execution Pipeline */}
      <div className="bg-[#0C121D] border border-slate-800 rounded p-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          {pipelineStages.map((stage, idx) => (
            <div
              key={stage.label}
              className="flex items-center justify-between gap-2 bg-[#090E17] border border-slate-800/90 rounded px-3 py-2"
            >
              <div className="min-w-0">
                <div className="text-[11px] text-slate-400 truncate">{stage.label}</div>
                <div
                  className={`text-xs font-mono font-semibold mt-0.5 truncate ${
                    stage.active ? 'text-emerald-400' : 'text-slate-200'
                  }`}
                >
                  {stage.metric}
                </div>
                <div className="text-[10px] font-mono text-slate-500 truncate">{stage.sub}</div>
              </div>
              {idx < pipelineStages.length - 1 && (
                <ArrowRight className="w-3.5 h-3.5 text-slate-600 shrink-0 hidden lg:block" />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Row 3: NSE Alpha Constellation Plot + Active Positions */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch">
        <div className="lg:col-span-6 bg-[#0C121D] border border-slate-800 rounded p-4">
          <div className="flex items-center justify-between mb-2">
            <div>
              <h2 className="text-sm font-semibold text-slate-100">
                NSE Alpha Constellation (Z-Score vs Relative Volume)
              </h2>
              <p className="text-[11px] text-slate-400">
                Live Upstox NSE_EQ quotes mapped by Z-Score &amp; RVOL. Zero simulated data.
              </p>
            </div>
          </div>
          {liveTickersCount === 0 ? (
            <div className="h-[220px] flex items-center justify-center border border-slate-800 bg-[#090E17] rounded text-xs text-slate-400 text-center px-6">
              Waiting for live Upstox market quotes (configure UPSTOX_ACCESS_TOKEN on your AWS
              server). No mock prices are plotted.
            </div>
          ) : (
            <AlphaScatterPlot
              tickers={state.tickers.filter((t) => t.ltp > 0)}
              vetoedSymbols={state.aiSupervisor?.vetoedSymbols ?? []}
              maxTicketInr={maxTicketInr}
            />
          )}
        </div>

        <div className="lg:col-span-6 bg-[#0C121D] border border-slate-800 rounded overflow-hidden flex flex-col">
          <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-100">
              Live Upstox Positions ({state.positions.length}/{state.guardrails.maxOpenPositions})
            </h2>
            <span className="text-[11px] font-mono text-slate-400">
              Auto-Squareoff {state.guardrails.autoSquareoffIst} IST
            </span>
          </div>

          {state.positions.length === 0 ? (
            <div className="flex-1 flex items-center justify-center p-6 text-xs text-slate-400 text-center">
              No active live Upstox positions open. The daemon auto-enters when NSE is open and a
              Long-Only BUY (Equity, CE, or PE) clears all 11 survival &amp; fee-drag gates.
            </div>
          ) : (
            <div className="overflow-x-auto flex-1">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-800 bg-[#090E17] text-slate-400 font-medium">
                    <th className="py-2 px-3">Symbol</th>
                    <th className="py-2 px-2">Side</th>
                    <th className="py-2 px-2 text-right">Qty</th>
                    <th className="py-2 px-2 text-right">Entry → LTP</th>
                    <th className="py-2 px-2 text-right">Stop / Target</th>
                    <th className="py-2 px-3 text-right">Net MTM</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70">
                  {state.positions.map((pos) => (
                    <tr key={pos.id} className="hover:bg-slate-800/30">
                      <td className="py-2.5 px-3 font-semibold text-slate-100">
                        {pos.symbol}
                        <div className="text-[10px] font-mono font-normal text-slate-400">
                          {pos.strategyId}
                        </div>
                      </td>
                      <td
                        className={`py-2.5 px-2 font-mono font-semibold ${
                          pos.side === 'BUY' ? 'text-emerald-400' : 'text-rose-400'
                        }`}
                      >
                        {pos.side}
                      </td>
                      <td className="py-2.5 px-2 text-right font-mono tabular-nums text-slate-200">
                        {pos.qty}
                      </td>
                      <td className="py-2.5 px-2 text-right font-mono tabular-nums text-slate-300">
                        {pos.entryPrice.toFixed(1)} → {pos.currentPrice.toFixed(1)}
                      </td>
                      <td className="py-2.5 px-2 text-right font-mono tabular-nums text-[11px]">
                        <span className="text-rose-400">
                          {(pos.trailingStop ?? pos.stopLoss).toFixed(1)}
                        </span>
                        <span className="text-slate-600"> / </span>
                        <span className="text-emerald-400">{pos.takeProfit.toFixed(1)}</span>
                      </td>
                      <td
                        className={`py-2.5 px-3 text-right font-mono font-semibold tabular-nums ${
                          pos.unrealizedPnlInr >= 0 ? 'text-emerald-400' : 'text-rose-400'
                        }`}
                      >
                        {formatSignedInr(pos.unrealizedPnlInr)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Row 4: Sector Exposure Matrix + Live Trade Stream */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch">
        <div className="lg:col-span-5 bg-[#0C121D] border border-slate-800 rounded p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-slate-100">
              NSE Sector Heatmap &amp; Exposure
            </h2>
            <span className="text-[11px] font-mono text-slate-400">
              Max {state.guardrails.maxSectorPositions}/sector
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {sectorRows.map((row) => {
              const isPos = row.avgChg >= 0;
              return (
                <div
                  key={row.sector}
                  className={`rounded border p-2.5 font-mono ${
                    isPos
                      ? 'bg-emerald-950/30 border-emerald-500/25'
                      : 'bg-rose-950/30 border-rose-500/25'
                  }`}
                >
                  <div className="text-[11px] font-sans font-medium text-slate-200 truncate">
                    {row.sector}
                  </div>
                  <div
                    className={`text-sm font-semibold tabular-nums mt-1 ${
                      isPos ? 'text-emerald-400' : 'text-rose-400'
                    }`}
                  >
                    {formatSignedPct(row.avgChg)}
                  </div>
                  <div className="text-[10px] text-slate-400 mt-1">
                    {row.signals} sig · {row.openCount} pos
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="lg:col-span-7 bg-[#0C121D] border border-slate-800 rounded overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-100">
              Executed Live Upstox Trades (Net of STT &amp; GST)
            </h2>
            <span className="text-xs font-mono tabular-nums text-slate-300">
              Realized {formatSignedInr(state.totalRealizedPnlInr)}
            </span>
          </div>

          {state.trades.length === 0 ? (
            <div className="p-6 text-center text-xs text-slate-400">
              No live Upstox round-trip trades executed yet.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-800 bg-[#090E17] text-slate-400 font-medium">
                    <th className="py-2 px-3">IST</th>
                    <th className="py-2 px-2">Symbol</th>
                    <th className="py-2 px-2 text-right">Qty</th>
                    <th className="py-2 px-2 text-right">Entry → Exit</th>
                    <th className="py-2 px-2 text-right">Charges</th>
                    <th className="py-2 px-2 text-right">Net PnL</th>
                    <th className="py-2 px-3 text-right">Reason</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70">
                  {state.trades.slice(0, 7).map((tr) => (
                    <tr key={tr.id} className="hover:bg-slate-800/30">
                      <td className="py-2 px-3 font-mono tabular-nums text-slate-400">
                        {formatTimeShort(tr.closedAt)}
                      </td>
                      <td className="py-2 px-2 font-semibold text-slate-100">
                        {tr.symbol}{' '}
                        <span
                          className={`font-mono text-[10px] ${
                            tr.side === 'BUY' ? 'text-emerald-400' : 'text-rose-400'
                          }`}
                        >
                          {tr.side}
                        </span>
                      </td>
                      <td className="py-2 px-2 text-right font-mono tabular-nums text-slate-300">
                        {tr.qty}
                      </td>
                      <td className="py-2 px-2 text-right font-mono tabular-nums text-slate-300">
                        {tr.entryPrice.toFixed(1)} → {tr.exitPrice.toFixed(1)}
                      </td>
                      <td className="py-2 px-2 text-right font-mono tabular-nums text-amber-400">
                        -{formatInr(tr.chargesInr)}
                      </td>
                      <td
                        className={`py-2 px-2 text-right font-mono font-semibold tabular-nums ${
                          tr.netPnlInr >= 0 ? 'text-emerald-400' : 'text-rose-400'
                        }`}
                      >
                        {formatSignedInr(tr.netPnlInr)}
                      </td>
                      <td className="py-2 px-3 text-right font-mono text-[11px] text-slate-400">
                        {tr.exitReason}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
