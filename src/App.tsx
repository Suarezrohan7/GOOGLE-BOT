import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  Cpu,
  FlaskConical,
  Menu,
  OctagonAlert,
  Pause,
  Play,
  Shield,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import type {
  BacktestResult,
  BotStateSnapshot,
  GuardrailsConfig,
  StrategyConfig,
  StrategyId,
} from './shared/types';
import { AuditArchitectureView } from './components/AuditArchitectureView';
import { BacktestView } from './components/BacktestView';
import { GuardrailsView } from './components/GuardrailsView';
import { OverviewView } from './components/OverviewView';
import { StrategiesView } from './components/StrategiesView';

type TabId = 'overview' | 'strategies' | 'guardrails' | 'backtest' | 'audit';

const NAV_ITEMS: Array<{ id: TabId; label: string; icon: typeof Activity }> = [
  { id: 'overview', label: 'Terminal Overview', icon: Activity },
  { id: 'strategies', label: 'Strategies & NSE Tape', icon: Cpu },
  { id: 'guardrails', label: 'Guardrails & Upstox', icon: SlidersHorizontal },
  { id: 'backtest', label: 'Upstox V3 Backtest', icon: FlaskConical },
  { id: 'audit', label: 'Risk Audit & Spec', icon: Shield },
];

export default function App() {
  const [state, setState] = useState<BotStateSnapshot | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>('overview');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const fetchState = useCallback(async () => {
    try {
      const resp = await fetch('/api/state');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = (await resp.json()) as BotStateSnapshot;
      setState(data);
      setFetchError(null);
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : 'Failed to load engine state');
    }
  }, []);

  useEffect(() => {
    void fetchState();
  }, [fetchState]);

  useEffect(() => {
    const intervalMs = state?.status === 'RUNNING' ? 2000 : 4000;
    const timer = setInterval(() => {
      void fetchState();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [state?.status, fetchState]);

  const postAction = async (url: string, body?: unknown) => {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = await resp.json();
    if (json && json.status) {
      setState(json as BotStateSnapshot);
    } else if (json && json.state) {
      setState(json.state as BotStateSnapshot);
    }
    return { ok: resp.ok, json };
  };

  const handlePauseResume = async () => {
    if (!state) return;
    if (state.status === 'PAUSED') {
      await postAction('/api/engine/resume');
    } else {
      await postAction('/api/engine/pause');
    }
  };

  const handleKillSwitch = async () => {
    await postAction('/api/engine/kill-switch', {
      reason: 'Operator activated Emergency Kill-Switch from terminal header.',
    });
  };

  const handleRunAiSupervisor = async () => {
    setAiLoading(true);
    setAiError(null);
    try {
      const { ok, json } = await postAction('/api/ai/evaluate');
      if (!ok) {
        setAiError(json?.error || 'Gemini AI evaluation failed.');
      }
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'AI Supervisor request error.');
    } finally {
      setAiLoading(false);
    }
  };

  const handleToggleAiAutoApply = async (enabled: boolean) => {
    await postAction('/api/ai/auto-apply', { enabled });
  };

  const handleSaveGuardrails = async (config: Partial<GuardrailsConfig>) => {
    const resp = await fetch('/api/guardrails', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    if (resp.ok) {
      const next = (await resp.json()) as BotStateSnapshot;
      setState(next);
    }
  };

  const handleUpdateStrategy = async (
    id: StrategyId,
    updates: Partial<
      Pick<
        StrategyConfig,
        'enabled' | 'capitalWeightPct' | 'minConfidence' | 'stopLossAtrMult' | 'targetAtrMult'
      >
    >
  ) => {
    const resp = await fetch(`/api/strategies/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    if (resp.ok) {
      const next = (await resp.json()) as BotStateSnapshot;
      setState(next);
    }
  };

  const handleResetEngine = async (newCapital?: number) => {
    await postAction('/api/engine/reset', { allocatedCapitalInr: newCapital });
  };

  const handleCheckStaticIp = async () => {
    await postAction('/api/system/static-ip');
  };

  const handleSyncUpstoxQuotes = async (): Promise<string | null> => {
    const { ok, json } = await postAction('/api/upstox/sync-quotes');
    return ok ? null : json?.error || 'Quote sync failed.';
  };

  const handleCheckUpstoxFunds = async (): Promise<{ ok: boolean; text: string }> => {
    const resp = await fetch('/api/upstox/funds');
    const json = await resp.json();
    if (!resp.ok) {
      return { ok: false, text: json?.error || 'Upstox funds lookup failed.' };
    }
    return {
      ok: true,
      text: `Available Margin: ₹${Number(json.availableMarginInr ?? 0).toLocaleString('en-IN')} · Used: ₹${Number(json.usedMarginInr ?? 0).toLocaleString('en-IN')}`,
    };
  };

  const handleRunBacktest = async (
    days: number
  ): Promise<{ ok: boolean; result?: BacktestResult; error?: string }> => {
    const resp = await fetch('/api/backtest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days }),
    });
    const json = await resp.json();
    if (!resp.ok) {
      return { ok: false, error: json?.error || 'Backtest failed.' };
    }
    return { ok: true, result: json as BacktestResult };
  };

  const statusTone = (status: BotStateSnapshot['status']) => {
    switch (status) {
      case 'RUNNING':
        return 'text-emerald-400';
      case 'AWAITING_MARKET_OPEN':
      case 'AWAITING_UPSTOX_TOKEN':
      case 'COOLDOWN':
      case 'SQUAREOFF_WINDOW':
      case 'PAUSED':
        return 'text-amber-400';
      case 'HALTED_DAILY_LOSS':
      case 'DEADMAN_LOCK':
        return 'text-rose-400';
    }
  };

  const activeNav = NAV_ITEMS.find((n) => n.id === activeTab)!;

  return (
    <div className="min-h-screen bg-[#070B12] text-slate-100 flex">
      <aside className="hidden lg:flex lg:w-60 lg:flex-col border-r border-slate-800 bg-[#090E17] shrink-0">
        <div className="h-14 px-5 flex items-center border-b border-slate-800">
          <span className="text-base font-bold tracking-tight text-slate-100 font-display whitespace-nowrap">
            Artha Quant
          </span>
        </div>

        <nav className="flex-1 p-3 space-y-1">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 text-xs font-medium rounded transition-colors whitespace-nowrap cursor-pointer ${
                  active
                    ? 'bg-slate-800 text-slate-100'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        {state && (
          <div className="p-4 border-t border-slate-800 text-[11px] space-y-2 text-slate-400">
            <div className="flex justify-between font-mono">
              <span>Broker</span>
              <span className="text-slate-200">UPSTOX LIVE</span>
            </div>
            <div className="flex justify-between font-mono">
              <span>Token</span>
              <span className={state.upstoxConnected ? 'text-emerald-400' : 'text-amber-400'}>
                {state.upstoxConnected ? 'CONNECTED' : 'PENDING'}
              </span>
            </div>
            <div className="flex justify-between font-mono">
              <span>NSE Session</span>
              <span
                className={
                  state.session.isWeekend || state.session.isHoliday
                    ? 'text-rose-400'
                    : state.session.phase === 'LIVE_TRADING'
                      ? 'text-emerald-400'
                      : 'text-amber-400'
                }
              >
                {state.session.isHoliday
                  ? 'HOLIDAY'
                  : state.session.isWeekend
                    ? 'WEEKEND'
                    : state.session.phase}
              </span>
            </div>
            <div className="flex justify-between font-mono">
              <span>IST Clock</span>
              <span className="text-slate-300 tabular-nums">{state.session.istTimeStr}</span>
            </div>
          </div>
        )}
      </aside>

      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-black/70"
            onClick={() => setMobileMenuOpen(false)}
          />
          <aside className="relative z-10 w-64 bg-[#090E17] border-r border-slate-800 flex flex-col">
            <div className="h-14 px-4 flex items-center justify-between border-b border-slate-800">
              <span className="text-base font-bold text-slate-100 font-display">
                Artha Quant
              </span>
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                className="p-1.5 text-slate-400 hover:text-slate-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <nav className="p-3 space-y-1">
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                const active = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setActiveTab(item.id);
                      setMobileMenuOpen(false);
                    }}
                    className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-xs font-medium rounded transition-colors ${
                      active
                        ? 'bg-slate-800 text-slate-100'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
          </aside>
        </div>
      )}

      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-14 px-4 lg:px-6 border-b border-slate-800 bg-[#090E17] flex items-center justify-between gap-4 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden p-1.5 text-slate-400 hover:text-slate-100"
              aria-label="Open menu"
            >
              <Menu className="w-5 h-5" />
            </button>

            <div className="flex items-center gap-2 text-xs truncate">
              <span className="font-semibold text-slate-200 lg:hidden">Artha Quant</span>
              <span className="text-slate-500 hidden sm:inline">Upstox Live Terminal</span>
              <span className="text-slate-600 hidden sm:inline">/</span>
              <span className="font-medium text-slate-100 truncate">{activeNav.label}</span>
              {state && (
                <>
                  <span className="text-slate-600 hidden md:inline">·</span>
                  <span className={`font-mono hidden md:inline ${statusTone(state.status)}`}>
                    {state.status}
                  </span>
                </>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            {state && (
              <>
                <button
                  type="button"
                  onClick={handlePauseResume}
                  disabled={
                    state.status === 'DEADMAN_LOCK' || state.status === 'HALTED_DAILY_LOSS'
                  }
                  className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-40 ${
                    state.status === 'PAUSED'
                      ? 'bg-emerald-400 text-slate-950 hover:bg-emerald-300'
                      : 'bg-slate-800 text-slate-200 hover:bg-slate-700'
                  }`}
                >
                  {state.status === 'PAUSED' ? (
                    <>
                      <Play className="w-3.5 h-3.5" />
                      Resume Auto
                    </>
                  ) : (
                    <>
                      <Pause className="w-3.5 h-3.5" />
                      Pause Auto
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={handleKillSwitch}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-rose-200 bg-rose-950/70 hover:bg-rose-900/80 border border-rose-500/40 rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <OctagonAlert className="w-3.5 h-3.5" />
                  Kill-Switch
                </button>
              </>
            )}
          </div>
        </header>

        <main className="flex-1 p-4 lg:p-6 max-w-[1600px] w-full mx-auto">
          {fetchError && (
            <div className="mb-4 p-3 bg-rose-950/60 border border-rose-500/40 rounded text-xs text-rose-200">
              Engine connection error: {fetchError}
            </div>
          )}

          {!state ? (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {[0, 1, 2].map((idx) => (
                <div
                  key={idx}
                  className="h-44 bg-[#0C121D] border border-slate-800 rounded animate-pulse"
                />
              ))}
            </div>
          ) : (
            <>
              {activeTab === 'overview' && (
                <OverviewView
                  state={state}
                  aiLoading={aiLoading}
                  aiError={aiError}
                  onRunAiSupervisor={handleRunAiSupervisor}
                  onToggleAiAutoApply={handleToggleAiAutoApply}
                  onSyncUpstox={handleSyncUpstoxQuotes}
                />
              )}
              {activeTab === 'strategies' && (
                <StrategiesView state={state} onUpdateStrategy={handleUpdateStrategy} />
              )}
              {activeTab === 'guardrails' && (
                <GuardrailsView
                  state={state}
                  onSaveGuardrails={handleSaveGuardrails}
                  onResetEngine={handleResetEngine}
                  onCheckStaticIp={handleCheckStaticIp}
                  onSyncUpstoxQuotes={handleSyncUpstoxQuotes}
                  onCheckUpstoxFunds={handleCheckUpstoxFunds}
                />
              )}
              {activeTab === 'backtest' && (
                <BacktestView onRunBacktest={handleRunBacktest} />
              )}
              {activeTab === 'audit' && <AuditArchitectureView state={state} />}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
