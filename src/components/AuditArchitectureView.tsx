import { useState } from 'react';
import type { BotStateSnapshot, RiskAuditEntry } from '../shared/types';
import { formatTimeShort } from '../utils/format';

interface AuditArchitectureViewProps {
  state: BotStateSnapshot;
}

export function AuditArchitectureView({ state }: AuditArchitectureViewProps) {
  const [filter, setFilter] = useState<'ALL' | RiskAuditEntry['decision']>('ALL');

  const filteredAudits = state.riskAudit.filter(
    (a) => filter === 'ALL' || a.decision === filter
  );

  const decisionColor = (d: RiskAuditEntry['decision']) => {
    switch (d) {
      case 'APPROVED':
        return 'text-emerald-400';
      case 'THROTTLED':
        return 'text-amber-400';
      case 'REJECTED':
        return 'text-slate-300';
      case 'CIRCUIT_BREAKER':
        return 'text-rose-400 font-semibold';
    }
  };

  return (
    <div className="space-y-4">
      {/* Architecture & Survival Specification */}
      <div className="bg-[#0C121D] border border-slate-800 rounded p-5">
        <h2 className="text-sm font-semibold text-slate-100">
          Live-Capital Survival Architecture &amp; Upstox AWS Static-IP Spec
        </h2>
        <p className="text-xs text-slate-400 mt-1 leading-relaxed">
          Designed so the bot protects your live Upstox account capital against bad trades,
          runaway loops, and Indian statutory fee erosion with zero top-ups or second chances.
        </p>

        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
          <div className="bg-[#090E17] border border-slate-800 rounded p-3.5">
            <div className="font-semibold text-emerald-400">01. Long-Only Survival Firewall</div>
            <p className="mt-1.5 text-slate-400 leading-relaxed">
              11 deterministic pre-trade checks run on the Express server before any Upstox order
              leaves: Long-Only BUY Gate (zero short selling), Up to 3 Concurrent Slots with No
              Same-Day Re-entry (never buys the same stock twice in a day), 25% Survival Floor,
              ₹1,000–₹2,000 ATR Sizing, and VWAP Price Collar.
            </p>
          </div>

          <div className="bg-[#090E17] border border-slate-800 rounded p-3.5">
            <div className="font-semibold text-amber-400">02. Self-Healing &amp; Fee Cover</div>
            <p className="mt-1.5 text-slate-400 leading-relaxed">
              Allocates 1.0x Cash-Only capital across diversified signals (max 60% per stock,
              expected profit &gt; 1.1x round-trip Upstox fees) with +0.60R fee-covered breakeven
              locks, automated 3s position reconciliation, and urgent MARKET stop exits.
            </p>
          </div>

          <div className="bg-[#090E17] border border-slate-800 rounded p-3.5">
            <div className="font-semibold text-sky-400">03. Quant Regime Supervisor</div>
            <p className="mt-1.5 text-slate-400 leading-relaxed">
              Runs locally with zero paid AI keys required: evaluates NSE breadth, India VIX, and
              survival headroom to scale sizing (0.25x–1.0x) and veto crowded traps—never able to
              loosen hard risk limits.
            </p>
          </div>

          <div className="bg-[#090E17] border border-slate-800 rounded p-3.5">
            <div className="font-semibold text-slate-100">04. NSE Official Calendar &amp; AWS IP</div>
            <p className="mt-1.5 text-slate-400 leading-relaxed">
              Synchronizes official NSE trading holidays and IST market phases (09:00 Pre-Open,
              09:15 Live, 15:05 MIS Auto-Squareoff, 15:30 Close) with AWS static IP readiness for
              Upstox HFT execution.
            </p>
          </div>
        </div>
      </div>

      {/* Live Risk Audit Log */}
      <div className="bg-[#0C121D] border border-slate-800 rounded overflow-hidden">
        <div className="px-4 py-3.5 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">
              Pre-Trade Risk Firewall Audit Log ({filteredAudits.length})
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Every candidate signal evaluated by the 11-gate engine is recorded with its exact rule
              verdict.
            </p>
          </div>

          <div className="flex items-center gap-1 p-1 bg-[#070B12] border border-slate-800 rounded">
            {(['ALL', 'APPROVED', 'THROTTLED', 'REJECTED', 'CIRCUIT_BREAKER'] as const).map(
              (tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setFilter(tab)}
                  className={`px-2.5 py-1 text-[11px] font-mono rounded transition-colors whitespace-nowrap cursor-pointer ${
                    filter === tab
                      ? 'bg-slate-800 text-slate-100'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {tab}
                </button>
              )
            )}
          </div>
        </div>

        {filteredAudits.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-400">
            No risk audit entries matching this filter yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-800 bg-[#090E17] text-slate-400 font-medium">
                  <th className="py-2.5 px-4">IST Time</th>
                  <th className="py-2.5 px-3">Verdict</th>
                  <th className="py-2.5 px-3">Symbol</th>
                  <th className="py-2.5 px-3 text-right">Qty Req → Appr</th>
                  <th className="py-2.5 px-3">Rule</th>
                  <th className="py-2.5 px-4">Reason</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {filteredAudits.map((entry) => (
                  <tr key={entry.id} className="hover:bg-slate-800/30">
                    <td className="py-2.5 px-4 font-mono tabular-nums text-slate-400">
                      {formatTimeShort(entry.timestamp)}
                    </td>
                    <td className={`py-2.5 px-3 font-mono ${decisionColor(entry.decision)}`}>
                      {entry.decision}
                    </td>
                    <td className="py-2.5 px-3 font-semibold text-slate-100">
                      {entry.symbol}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-300">
                      {entry.requestedQty} → {entry.approvedQty}
                    </td>
                    <td className="py-2.5 px-3 font-mono text-[11px] text-sky-300">
                      {entry.rule}
                    </td>
                    <td className="py-2.5 px-4 text-slate-300">{entry.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
