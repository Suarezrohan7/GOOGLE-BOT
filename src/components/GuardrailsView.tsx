import { useEffect, useState } from 'react';
import { RefreshCw, Server, ShieldCheck } from 'lucide-react';
import type { BotStateSnapshot, GuardrailsConfig } from '../shared/types';
import { formatInr } from '../utils/format';

interface GuardrailsViewProps {
  state: BotStateSnapshot;
  onSaveGuardrails: (config: Partial<GuardrailsConfig>) => Promise<void>;
  onResetEngine: (newCapital?: number) => Promise<void>;
  onCheckStaticIp: () => Promise<void>;
  onSyncUpstoxQuotes: () => Promise<string | null>;
  onCheckUpstoxFunds: () => Promise<{ ok: boolean; text: string }>;
}

export function GuardrailsView({
  state,
  onSaveGuardrails,
  onResetEngine,
  onCheckStaticIp,
  onSyncUpstoxQuotes,
  onCheckUpstoxFunds,
}: GuardrailsViewProps) {
  const [form, setForm] = useState<GuardrailsConfig>(state.guardrails);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [upstoxFeedback, setUpstoxFeedback] = useState<string | null>(null);
  const [ipChecking, setIpChecking] = useState(false);

  useEffect(() => {
    setForm(state.guardrails);
  }, [state.guardrails]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    await onSaveGuardrails(form);
    setSavedMsg('Guardrails saved and enforced on server.');
    setTimeout(() => setSavedMsg(null), 3000);
  };

  const handleIpCheck = async () => {
    setIpChecking(true);
    await onCheckStaticIp();
    setIpChecking(false);
  };

  const handleSyncQuotes = async () => {
    setUpstoxFeedback('Syncing NSE_EQ quotes from Upstox v2...');
    const err = await onSyncUpstoxQuotes();
    setUpstoxFeedback(err ? `Upstox Error: ${err}` : 'Live NSE_EQ quotes synced from Upstox v2.');
  };

  const handleCheckFunds = async () => {
    setUpstoxFeedback('Checking Upstox SEC equity margin...');
    const res = await onCheckUpstoxFunds();
    setUpstoxFeedback(res.text);
  };

  const handleRequestWhatsAppToken = async () => {
    setUpstoxFeedback('Sending Upstox mobile/WhatsApp 1-tap approval prompt...');
    try {
      const resp = await fetch('/api/upstox/request-token', { method: 'POST' });
      const json = (await resp.json()) as { message?: string; error?: string };
      setUpstoxFeedback(
        resp.ok
          ? json.message || 'Approval prompt sent to your Upstox App & WhatsApp.'
          : `Error: ${json.error || 'Token request failed'}`
      );
    } catch (err) {
      setUpstoxFeedback(err instanceof Error ? err.message : 'Request failed');
    }
  };

  const survivalFloorPreview = form.allocatedCapitalInr * (1 - form.maxTotalDrawdownPct / 100);
  const dailyLossPreview = form.allocatedCapitalInr * (form.maxDailyLossPct / 100);
  const perTradeRiskPreview = form.allocatedCapitalInr * (form.riskPerTradePct / 100);
  const upstoxStatus = state.brokers[0];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <form
          onSubmit={handleSave}
          className="lg:col-span-7 bg-[#0C121D] border border-slate-800 rounded p-5 space-y-5"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-slate-800">
            <div>
              <h2 className="text-sm font-semibold text-slate-100">
                Survival Guardrails &amp; Capital Limits
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Hard server-side pre-trade gates for live Upstox execution. Cannot be bypassed by AI.
              </p>
            </div>
            <button
              type="submit"
              className="px-4 py-2 text-xs font-medium text-slate-950 bg-emerald-400 hover:bg-emerald-300 rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Apply Guardrails
            </button>
          </div>

          {savedMsg && (
            <div className="p-3 bg-emerald-950/60 border border-emerald-500/40 rounded text-xs text-emerald-200">
              {savedMsg}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
            <label className="block">
              <span className="font-medium text-slate-300">Live Capital (₹ INR, Auto-Synced)</span>
              <input
                type="number"
                min={0}
                step={100}
                value={form.allocatedCapitalInr}
                onChange={(e) =>
                  setForm({ ...form, allocatedCapitalInr: Number(e.target.value) })
                }
                className="mt-1.5 w-full px-3 py-2 border border-slate-700 rounded font-mono tabular-nums bg-[#070B12] text-slate-100"
              />
              <span className="text-[11px] text-slate-400 mt-1 block">
                Auto-syncs directly from Upstox live SEC margin (deposits reflect in 3–15s)
              </span>
            </label>

            <label className="block">
              <span className="font-medium text-slate-300">
                Max Total Drawdown Survival Floor (%)
              </span>
              <input
                type="number"
                min={1}
                max={100}
                step={0.5}
                value={form.maxTotalDrawdownPct}
                onChange={(e) =>
                  setForm({ ...form, maxTotalDrawdownPct: Number(e.target.value) })
                }
                className="mt-1.5 w-full px-3 py-2 border border-slate-700 rounded font-mono tabular-nums bg-[#070B12] text-slate-100"
              />
              <span className="text-[11px] text-rose-400 mt-1 block font-mono">
                {form.maxTotalDrawdownPct >= 100
                  ? 'Survival floor ₹0 (only locks if account hits ₹0)'
                  : `Dead-man lock engages at ${formatInr(survivalFloorPreview)}`}
              </span>
            </label>

            <label className="block">
              <span className="font-medium text-slate-300">Daily Max Loss Circuit Breaker (%)</span>
              <input
                type="number"
                min={0.5}
                max={100}
                step={0.5}
                value={form.maxDailyLossPct}
                onChange={(e) => setForm({ ...form, maxDailyLossPct: Number(e.target.value) })}
                className="mt-1.5 w-full px-3 py-2 border border-slate-700 rounded font-mono tabular-nums bg-[#070B12] text-slate-100"
              />
              <span className="text-[11px] text-slate-400 mt-1 block font-mono">
                {form.maxDailyLossPct >= 100
                  ? '100% = full intraday comeback allowed'
                  : `Halts session at -${formatInr(dailyLossPreview)}/day`}
              </span>
            </label>

            <label className="block">
              <span className="font-medium text-slate-300">Max Risk Per Trade (%)</span>
              <input
                type="number"
                min={0.5}
                max={25}
                step={0.5}
                value={form.riskPerTradePct}
                onChange={(e) => setForm({ ...form, riskPerTradePct: Number(e.target.value) })}
                className="mt-1.5 w-full px-3 py-2 border border-slate-700 rounded font-mono tabular-nums bg-[#070B12] text-slate-100"
              />
              <span className="text-[11px] text-slate-400 mt-1 block font-mono">
                Max stop-loss {formatInr(perTradeRiskPreview)} per trade
              </span>
            </label>

            <label className="block">
              <span className="font-medium text-slate-300">Max Open Positions (No Duplicates)</span>
              <input
                type="number"
                min={1}
                max={10}
                value={form.maxOpenPositions}
                onChange={(e) =>
                  setForm({ ...form, maxOpenPositions: Number(e.target.value) })
                }
                className="mt-1.5 w-full px-3 py-2 border border-slate-700 rounded font-mono tabular-nums bg-[#070B12] text-slate-100"
              />
              <span className="text-[11px] text-emerald-400 mt-1 block font-mono">
                Long-Only BUY Gate active (Short selling locked)
              </span>
            </label>

            <label className="block">
              <span className="font-medium text-slate-300">Max Single Stock Weight (%)</span>
              <input
                type="number"
                min={10}
                max={100}
                value={form.maxSingleStockWeightPct}
                onChange={(e) =>
                  setForm({ ...form, maxSingleStockWeightPct: Number(e.target.value) })
                }
                className="mt-1.5 w-full px-3 py-2 border border-slate-700 rounded font-mono tabular-nums bg-[#070B12] text-slate-100"
              />
            </label>

            <label className="block">
              <span className="font-medium text-slate-300">India VIX Throttle Threshold</span>
              <input
                type="number"
                min={11}
                max={35}
                step={0.5}
                value={form.vixThrottleThreshold}
                onChange={(e) =>
                  setForm({ ...form, vixThrottleThreshold: Number(e.target.value) })
                }
                className="mt-1.5 w-full px-3 py-2 border border-slate-700 rounded font-mono tabular-nums bg-[#070B12] text-slate-100"
              />
            </label>

            <label className="block">
              <span className="font-medium text-slate-300">NSE Product Type &amp; Squareoff</span>
              <div className="mt-1.5 flex items-center gap-2">
                <select
                  value={form.productType}
                  onChange={(e) =>
                    setForm({ ...form, productType: e.target.value as 'MIS' | 'CNC' })
                  }
                  className="w-1/2 px-3 py-2 border border-slate-700 rounded font-mono bg-[#070B12] text-slate-100"
                >
                  <option value="MIS">MIS (Intraday)</option>
                  <option value="CNC">CNC (Delivery)</option>
                </select>
                <input
                  type="text"
                  value={form.autoSquareoffIst}
                  onChange={(e) => setForm({ ...form, autoSquareoffIst: e.target.value })}
                  className="w-1/2 px-3 py-2 border border-slate-700 rounded font-mono tabular-nums bg-[#070B12] text-slate-100"
                />
              </div>
            </label>
          </div>

          <div className="pt-4 border-t border-slate-800 space-y-3 text-xs">
            <label className="flex items-center justify-between gap-3 p-3 rounded border border-slate-800 bg-[#090E17] cursor-pointer">
              <div>
                <div className="font-medium text-slate-200">
                  Allow Index Option Buying (BUY CE / BUY PE on NIFTY 50)
                </div>
                <div className="text-[11px] text-slate-400 mt-0.5">
                  Buys nearest-expiry CE on strong bullish setups or PE on bearish drops within your
                  live Upstox balance. Never writes/shorts options.
                </div>
              </div>
              <input
                type="checkbox"
                checked={form.allowIndexOptions !== false}
                onChange={(e) => setForm({ ...form, allowIndexOptions: e.target.checked })}
                className="w-4 h-4 accent-emerald-400 shrink-0"
              />
            </label>

            <div className="flex flex-wrap items-center justify-between gap-4">
              <span className="text-slate-400">
                Live money mode active (1.0x cash only, zero margin): weekend, NSE holiday, and
                post-{state.guardrails.autoSquareoffIst} IST orders are strictly locked.
              </span>

              <button
                type="button"
                onClick={() => onResetEngine(form.allocatedCapitalInr)}
                className="px-3 py-1.5 text-xs font-medium text-rose-300 bg-rose-950/60 hover:bg-rose-900/60 border border-rose-500/40 rounded transition-colors whitespace-nowrap cursor-pointer"
              >
                Reset Ledger to {formatInr(form.allocatedCapitalInr, true)}
              </button>
            </div>
          </div>
        </form>

        <div className="lg:col-span-5 space-y-4">
          <div className="bg-[#0C121D] border border-slate-800 rounded p-5 space-y-4">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              <h2 className="text-sm font-semibold text-slate-100">
                Upstox Live Connection (No Paper Mode)
              </h2>
            </div>

            {upstoxStatus && (
              <div className="p-3.5 rounded border border-slate-800 bg-[#090E17] space-y-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-slate-100">{upstoxStatus.label}</span>
                  <span
                    className={`font-mono ${
                      state.upstoxConnected ? 'text-emerald-400' : 'text-amber-400'
                    }`}
                  >
                    {state.upstoxConnected ? 'CONNECTED' : 'TOKEN REQUIRED'}
                  </span>
                </div>
                <div className="text-[11px] text-slate-400">{upstoxStatus.notes}</div>
                {state.upstoxLiveBalanceInr !== null && (
                  <div className="text-xs font-mono text-sky-400">
                    Live SEC Equity Margin: {formatInr(state.upstoxLiveBalanceInr)}
                  </div>
                )}
                {state.upstoxAccountError && (
                  <div className="text-[11px] font-mono text-amber-300">
                    {state.upstoxAccountError}
                  </div>
                )}
                {!upstoxStatus.configured && (
                  <div className="text-[11px] font-mono text-slate-300 pt-1">
                    Set UPSTOX_ACCESS_TOKEN in server environment (.env / Secrets). Engine auto-arms
                    immediately on startup.
                  </div>
                )}
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              {state.upstoxOAuthConfigured && (
                <>
                  <a
                    href="/api/upstox/login"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-3 py-1.5 text-xs font-medium bg-emerald-400 hover:bg-emerald-300 text-slate-950 rounded transition-colors whitespace-nowrap"
                  >
                    1-Tap Upstox Login
                  </a>
                  <button
                    type="button"
                    onClick={handleRequestWhatsAppToken}
                    className="px-3 py-1.5 text-xs font-medium bg-sky-500/20 hover:bg-sky-500/30 text-sky-300 border border-sky-500/30 rounded transition-colors whitespace-nowrap cursor-pointer"
                  >
                    Send WhatsApp/App Prompt
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={handleSyncQuotes}
                className="px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded transition-colors whitespace-nowrap cursor-pointer"
              >
                Sync Upstox Quotes &amp; Balance
              </button>
              <button
                type="button"
                onClick={handleCheckFunds}
                className="px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded transition-colors whitespace-nowrap cursor-pointer"
              >
                Check Upstox ₹ Balance
              </button>
            </div>
            <div className="text-[11px] font-mono text-slate-400">
              OAuth Redirect: /api/upstox/callback · Notifier Webhook: /api/upstox/notifier-webhook
            </div>

            {upstoxFeedback && (
              <div className="p-2.5 bg-[#070B12] border border-slate-800 rounded text-xs font-mono text-slate-300">
                {upstoxFeedback}
              </div>
            )}
          </div>

          <div className="bg-[#0C121D] border border-slate-800 rounded p-5 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Server className="w-4 h-4 text-sky-400" />
                <h2 className="text-sm font-semibold text-slate-100">
                  AWS Static IP &amp; SEBI Algo Readiness
                </h2>
              </div>
              <button
                type="button"
                onClick={handleIpCheck}
                disabled={ipChecking}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded transition-colors whitespace-nowrap cursor-pointer"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${ipChecking ? 'animate-spin' : ''}`} />
                Detect IP
              </button>
            </div>

            <div className="text-xs space-y-2 text-slate-300">
              <div className="flex items-center justify-between py-1.5 border-b border-slate-800 font-mono tabular-nums">
                <span className="font-sans text-slate-400">Server Outbound IP</span>
                <span className="font-semibold text-slate-100">
                  {state.staticIp.serverOutboundIp || 'Not checked yet'}
                </span>
              </div>
              <div className="flex items-center justify-between py-1.5 border-b border-slate-800 font-mono">
                <span className="font-sans text-slate-400">WebSocket Bridge Hook</span>
                <span className="text-sky-300">POST {state.staticIp.webhookEndpoint}</span>
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed pt-1">
                {state.staticIp.notes}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Official NSE Timings & Holiday Calendar */}
      <div className="bg-[#0C121D] border border-slate-800 rounded p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-800">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">
              Official NSE Market Calendar &amp; Session Guard
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Live Upstox execution is strictly blocked on weekends (Sat/Sun), official NSE
              holidays, Pre-Open (09:00–09:15), and after {state.guardrails.autoSquareoffIst} IST
              MIS cutoff. Source:{' '}
              <span className="font-mono text-slate-300">{state.session.calendarSource}</span>
            </p>
          </div>
          <div className="text-xs font-mono tabular-nums text-slate-300">
            {state.session.istDateStr} · {state.session.istTimeStr} ·{' '}
            <span
              className={
                state.session.isWeekend || state.session.isHoliday
                  ? 'text-rose-400 font-semibold'
                  : state.session.phase === 'LIVE_TRADING'
                    ? 'text-emerald-400 font-semibold'
                    : 'text-amber-400 font-semibold'
              }
            >
              {state.session.isHoliday
                ? `HOLIDAY (${state.session.holidayName})`
                : state.session.isWeekend
                  ? 'WEEKEND CLOSED'
                  : state.session.phase}
            </span>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
          <div className="space-y-1.5 font-mono">
            <div className="font-sans font-medium text-slate-300 mb-2">
              NSE Equity Timings (Mon–Fri IST)
            </div>
            <div className="flex justify-between py-1 border-b border-slate-800/80 text-slate-300">
              <span className="font-sans text-slate-400">Pre-Open Order Entry</span>
              <span>09:00 – 09:08 IST</span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-800/80 text-slate-300">
              <span className="font-sans text-slate-400">Regular Continuous Session</span>
              <span className="text-emerald-400">09:15 – 15:30 IST</span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-800/80 text-slate-300">
              <span className="font-sans text-slate-400">MIS Auto-Squareoff Cutoff</span>
              <span className="text-amber-400">{state.guardrails.autoSquareoffIst} IST</span>
            </div>
            <div className="flex justify-between py-1 text-slate-300">
              <span className="font-sans text-slate-400">Post-Close Session</span>
              <span>15:40 – 16:00 IST</span>
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="font-medium text-slate-300 mb-2">Upcoming Official NSE Holidays</div>
            {state.session.nextHolidays.length === 0 ? (
              <div className="text-slate-400">No upcoming holidays remaining in 2026 schedule.</div>
            ) : (
              state.session.nextHolidays.map((h) => (
                <div
                  key={h.date}
                  className="flex items-center justify-between py-1.5 border-b border-slate-800/80 text-slate-300"
                >
                  <span>{h.description}</span>
                  <span className="font-mono text-rose-400">{h.date}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
