import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AiSupervisorReport,
  BotStateSnapshot,
  EngineStatus,
  EquityPoint,
  GuardrailsConfig,
  InstrumentType,
  MarketTickerSnapshot,
  OrderSide,
  Position,
  RiskAuditEntry,
  SectorName,
  StaticIpInfo,
  StrategyConfig,
  StrategyId,
  TradeRecord,
} from '../shared/types.ts';
import { executeLiveUpstoxOrder, getBrokerStatuses } from './brokers.ts';
import {
  calculateIndianTransactionCosts,
  getIstMarketSession,
  refreshNseOfficialHolidays,
  round2,
} from './indiaMarket.ts';
import { computeSurvivalFloor, evaluatePreTradeRisk } from './riskEngine.ts';
import { runAiMarketSupervisor } from './aiSupervisor.ts';
import {
  exchangeUpstoxAuthCode,
  fetchAffordableNiftyOption,
  fetchUpstoxFunds,
  fetchUpstoxHistoricalCandles,
  fetchUpstoxIndexSnapshots,
  fetchUpstoxIntradayCandles,
  fetchUpstoxNseQuotes,
  fetchUpstoxPositions,
  fetchUpstoxSingleQuote,
  getUpstoxAccessToken,
  requestUpstoxAccessTokenViaNotifier,
  resolveUpstoxInstrumentKey,
  saveUpstoxAccessToken,
} from './upstoxClient.ts';
import { pollTelegramCommands, sendTelegramAlert } from './telegramBot.ts';
import { getCachedMarketNewsDigest, refreshMarketNewsDigest } from './newsFeed.ts';

interface StockMeta {
  symbol: string;
  name: string;
  sector: SectorName;
}

const NSE_UNIVERSE: StockMeta[] = [
  { symbol: 'RELIANCE', name: 'Reliance Industries', sector: 'Energy' },
  { symbol: 'HDFCBANK', name: 'HDFC Bank Ltd', sector: 'Banking' },
  { symbol: 'ICICIBANK', name: 'ICICI Bank Ltd', sector: 'Banking' },
  { symbol: 'INFY', name: 'Infosys Ltd', sector: 'IT' },
  { symbol: 'TCS', name: 'Tata Consultancy', sector: 'IT' },
  { symbol: 'SBIN', name: 'State Bank of India', sector: 'Banking' },
  { symbol: 'AXISBANK', name: 'Axis Bank Ltd', sector: 'Banking' },
  { symbol: 'LT', name: 'Larsen & Toubro', sector: 'CapitalGoods' },
  { symbol: 'BHARTIARTL', name: 'Bharti Airtel', sector: 'Telecom' },
  { symbol: 'WIPRO', name: 'Wipro Limited', sector: 'IT' },
  { symbol: 'SUNPHARMA', name: 'Sun Pharma Ind', sector: 'Pharma' },
  { symbol: 'ITC', name: 'ITC Limited', sector: 'FMCG' },
];

const DEFAULT_GUARDRAILS: GuardrailsConfig = {
  allocatedCapitalInr: 0,
  maxDailyLossPct: 100.0,
  maxTotalDrawdownPct: 25.0,
  riskPerTradePct: 15.0,
  maxOpenPositions: 3,
  maxSingleStockWeightPct: 60,
  maxSectorPositions: 2,
  maxOrdersPerMinute: 6,
  consecutiveLossCooldownCount: 3,
  cooldownMinutes: 30,
  vixThrottleThreshold: 18.0,
  autoSquareoffIst: '15:05',
  slippageBps: 5,
  productType: 'MIS',
  allowIndexOptions: true,
};

const DEFAULT_STRATEGIES: StrategyConfig[] = [
  {
    id: 'ORB_VWAP',
    name: 'ORB + VWAP Momentum',
    description:
      'Institutional VWAP + EMA trend continuation confirmed by relative volume >= 1.05x.',
    enabled: true,
    capitalWeightPct: 40,
    minConfidence: 62,
    stopLossAtrMult: 1.15,
    targetAtrMult: 2.2,
    tradesCount: 0,
    winCount: 0,
    netPnlInr: 0,
  },
  {
    id: 'MEAN_REVERSION',
    name: 'Bollinger Z-Score Reversion',
    description:
      'Fades intraday oversold Z-score (-1.25σ) & RSI exhaustion snapping off intraday low.',
    enabled: true,
    capitalWeightPct: 30,
    minConfidence: 60,
    stopLossAtrMult: 1.0,
    targetAtrMult: 1.85,
    tradesCount: 0,
    winCount: 0,
    netPnlInr: 0,
  },
  {
    id: 'PAIRS_SPREAD',
    name: 'Sector Pairs Spread',
    description:
      'Market-neutral relative-value catch-up across correlated sector leaders (HDFC/ICICI, INFY/TCS).',
    enabled: true,
    capitalWeightPct: 30,
    minConfidence: 63,
    stopLossAtrMult: 1.1,
    targetAtrMult: 2.0,
    tradesCount: 0,
    winCount: 0,
    netPnlInr: 0,
  },
];

interface PersistedState {
  status: EngineStatus;
  statusReason: string;
  cooldownUntil: string | null;
  tickCount: number;
  lastTickAt: string;
  initialCapitalInr: number;
  peakEquityInr: number;
  realizedPnlInr: number;
  dailyPnlInr: number;
  totalChargesPaidInr: number;
  consecutiveLosses: number;
  maxDrawdownSeenPct: number;
  nifty50: number;
  niftyBase: number;
  indiaVix: number;
  upstoxLiveBalanceInr: number | null;
  upstoxLastSyncAt: string | null;
  upstoxAccountError: string | null;
  guardrails: GuardrailsConfig;
  strategies: StrategyConfig[];
  tickers: MarketTickerSnapshot[];
  positions: Position[];
  trades: TradeRecord[];
  riskAudit: RiskAuditEntry[];
  equityCurve: EquityPoint[];
  aiSupervisor: AiSupervisorReport | null;
  aiThrottleMultiplier: number;
  aiAutoApply: boolean;
  lastSessionIstDate?: string | null;
  lastNotifierPromptAtMs?: number;
  tokenApprovedAfterResetIstDate?: string | null;
  tokenPromptsSentIstDate?: string | null;
  tokenPromptSlotsSent?: string[];
}

const DATA_DIR = path.resolve(process.cwd(), 'data');
const STATE_FILE = path.join(DATA_DIR, 'bot-state.json');
const TRADE_HISTORY_FILE = path.join(DATA_DIR, 'trade-history.jsonl');

export class TradingEngine {
  private state: PersistedState;
  private priceHistories: Map<string, number[]> = new Map();
  private lastBarPushMs: Map<string, number> = new Map();
  private avgDailyVolumes: Map<string, number> = new Map();
  private warmedUpIstDate: string | null = null;
  private isWarmingUp = false;
  private recentOrderTimestamps: number[] = [];
  private timer: NodeJS.Timeout | null = null;
  private isStepping = false;
  private lastStepStartedAtMs = 0;
  private lastAiRunMs = 0;
  private lastNotifierPromptMs = 0;
  private staticIp: StaticIpInfo = {
    serverOutboundIp: null,
    checkedAt: null,
    sebiWhitelistReady: false,
    webhookEndpoint: '/api/market-data/tick',
    notes:
      'SEBI algo regulations require whitelisting your AWS static IP in your Upstox Developer Console.',
  };

  constructor() {
    this.state = this.loadOrCreateState();
    this.lastNotifierPromptMs = this.state.lastNotifierPromptAtMs ?? 0;
    for (const ticker of this.state.tickers) {
      if (ticker.ltp > 0) {
        this.priceHistories.set(ticker.symbol, [ticker.prevClose || ticker.ltp, ticker.ltp]);
      }
    }
    void refreshNseOfficialHolidays();
    // Autonomous startup: immediately verify Upstox account & start the live daemon
    void this.bootstrapAutonomousEngine();
  }

  private createInitialState(): PersistedState {
    const nowIso = new Date().toISOString();
    const initialCapital = DEFAULT_GUARDRAILS.allocatedCapitalInr;
    const hasToken = Boolean(getUpstoxAccessToken());

    const tickers: MarketTickerSnapshot[] = NSE_UNIVERSE.map((s) => ({
      symbol: s.symbol,
      name: s.name,
      sector: s.sector,
      instrumentKey: resolveUpstoxInstrumentKey(s.symbol),
      ltp: 0,
      open: 0,
      high: 0,
      low: 0,
      prevClose: 0,
      changePct: 0,
      vwap: 0,
      atr14: 0,
      rsi14: 50,
      zScore: 0,
      rvol: 1.0,
      ema9: 0,
      ema21: 0,
      signal: null,
      signalSide: null,
      signalConfidence: 0,
      lastQuoteAt: null,
    }));

    return {
      status: hasToken ? 'AWAITING_MARKET_OPEN' : 'AWAITING_UPSTOX_TOKEN',
      statusReason: hasToken
        ? 'Upstox token detected; verifying account margin and NSE session schedule.'
        : 'Waiting for UPSTOX_ACCESS_TOKEN in server environment (.env / Secrets). Zero paper trades will run.',
      cooldownUntil: null,
      tickCount: 0,
      lastTickAt: nowIso,
      initialCapitalInr: initialCapital,
      peakEquityInr: initialCapital,
      realizedPnlInr: 0,
      dailyPnlInr: 0,
      totalChargesPaidInr: 0,
      consecutiveLosses: 0,
      maxDrawdownSeenPct: 0,
      nifty50: 0,
      niftyBase: 0,
      indiaVix: 14.0,
      upstoxLiveBalanceInr: null,
      upstoxLastSyncAt: null,
      upstoxAccountError: null,
      guardrails: { ...DEFAULT_GUARDRAILS },
      strategies: DEFAULT_STRATEGIES.map((s) => ({ ...s })),
      tickers,
      positions: [],
      trades: [],
      riskAudit: [],
      equityCurve: [
        {
          timestamp: nowIso,
          label: 'Start',
          equityInr: initialCapital,
          drawdownPct: 0,
          survivalFloorInr: computeSurvivalFloor(
            initialCapital,
            DEFAULT_GUARDRAILS.maxTotalDrawdownPct,
            initialCapital
          ),
        },
      ],
      aiSupervisor: null,
      aiThrottleMultiplier: 1.0,
      aiAutoApply: true,
      lastSessionIstDate: null,
    };
  }

  private loadOrCreateState(): PersistedState {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const raw = fs.readFileSync(STATE_FILE, 'utf-8');
        const parsed = JSON.parse(raw) as PersistedState;
        if (parsed && parsed.guardrails && Array.isArray(parsed.tickers)) {
          const existingMap = new Map(parsed.tickers.map((t) => [t.symbol, t]));
          parsed.tickers = NSE_UNIVERSE.map((s) => {
            const existing = existingMap.get(s.symbol);
            if (existing) {
              return { ...existing, instrumentKey: resolveUpstoxInstrumentKey(s.symbol) };
            }
            return {
              symbol: s.symbol,
              name: s.name,
              sector: s.sector,
              instrumentKey: resolveUpstoxInstrumentKey(s.symbol),
              ltp: 0,
              open: 0,
              high: 0,
              low: 0,
              prevClose: 0,
              changePct: 0,
              vwap: 0,
              atr14: 0,
              rsi14: 50,
              zScore: 0,
              rvol: 1.0,
              ema9: 0,
              ema21: 0,
              signal: null,
              signalSide: null,
              signalConfidence: 0,
              lastQuoteAt: null,
            };
          });
          // Apply user-calibrated multi-slot & 25% survival defaults on fresh/zero-trade deployments
          if (parsed.trades.length === 0 && parsed.positions.length === 0) {
            if (
              parsed.guardrails.maxTotalDrawdownPct === 50 ||
              parsed.guardrails.maxTotalDrawdownPct === 100
            ) {
              parsed.guardrails.maxTotalDrawdownPct = 25.0;
            }
            if (
              parsed.guardrails.maxDailyLossPct === 25 ||
              parsed.guardrails.maxDailyLossPct === 6
            ) {
              parsed.guardrails.maxDailyLossPct = 100.0;
            }
            if (parsed.guardrails.autoSquareoffIst === '15:15') {
              parsed.guardrails.autoSquareoffIst = '15:05';
            }
            if (
              parsed.guardrails.riskPerTradePct === 5 ||
              parsed.guardrails.riskPerTradePct === 8 ||
              parsed.guardrails.riskPerTradePct === 3.5
            ) {
              parsed.guardrails.riskPerTradePct = 15.0;
            }
            if (parsed.guardrails.maxOpenPositions === 1) {
              parsed.guardrails.maxOpenPositions = 3;
            }
            if (parsed.guardrails.maxSectorPositions === 1) {
              parsed.guardrails.maxSectorPositions = 2;
            }
            if (
              parsed.guardrails.maxSingleStockWeightPct === 95 ||
              parsed.guardrails.maxSingleStockWeightPct === 100
            ) {
              parsed.guardrails.maxSingleStockWeightPct = 60;
            }
            parsed.strategies = parsed.strategies.map((s) => {
              if (s.tradesCount > 0) return s;
              const def = DEFAULT_STRATEGIES.find((d) => d.id === s.id);
              return def
                ? {
                    ...s,
                    minConfidence: def.minConfidence,
                    targetAtrMult: def.targetAtrMult,
                  }
                : s;
            });
            if (parsed.upstoxLiveBalanceInr === null) {
              parsed.guardrails.allocatedCapitalInr = 0;
              parsed.initialCapitalInr = 0;
              parsed.peakEquityInr = 0;
              parsed.equityCurve = parsed.equityCurve.slice(0, 1).map((pt) => ({
                ...pt,
                equityInr: 0,
                survivalFloorInr: 0,
              }));
            }
          }
          return parsed;
        }
      }
    } catch {
      // Fallback to fresh state
    }
    const fresh = this.createInitialState();
    this.persistState(fresh);
    return fresh;
  }

  private persistState(target: PersistedState = this.state): void {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      fs.writeFileSync(STATE_FILE, JSON.stringify(target, null, 2), 'utf-8');
    } catch {
      // Ignore transient disk write failures
    }
  }

  private async bootstrapAutonomousEngine(): Promise<void> {
    try {
      if (getUpstoxAccessToken()) {
        const session = getIstMarketSession(
          this.state.guardrails.autoSquareoffIst,
          this.state.nifty50,
          0,
          this.state.indiaVix,
          this.state.guardrails.vixThrottleThreshold
        );
        await this.warmUpUniverseIfNeeded(session.istDateStr);
        await this.syncUpstoxAccountAndQuotes();
      }
    } catch {
      // Self-healing: continue starting timer even if initial sync encounters transient error
    }
    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.autonomousTick();
      }, 3000);
    }
  }

  private getIstSessionFraction(): number {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date());
    const map: Record<string, string> = {};
    for (const p of parts) map[p.type] = p.value;
    if (map.weekday === 'Sat' || map.weekday === 'Sun') return 1.0;
    const totalMins = Number(map.hour || '0') * 60 + Number(map.minute || '0');
    if (totalMins < 9 * 60 + 15 || totalMins >= 15 * 60 + 30) {
      return 1.0; // Full-day volume on closing/pre-open quotes
    }
    const elapsed = totalMins - (9 * 60 + 15);
    return Math.min(1, Math.max(0.08, elapsed / 375));
  }

  private getIstClock(): {
    istDateStr: string;
    hour: number;
    minute: number;
    totalMins: number;
  } {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(now);
    const map: Record<string, string> = {};
    for (const p of parts) map[p.type] = p.value;
    const hour = Number(map.hour || '0');
    const minute = Number(map.minute || '0');
    return {
      istDateStr: `${map.year}-${map.month}-${map.day}`,
      hour,
      minute,
      totalMins: hour * 60 + minute,
    };
  }

  public markTokenApprovedToday(): void {
    const clock = this.getIstClock();
    this.state.upstoxAccountError = null;
    // Upstox invalidates yesterday's token at 03:30 IST. Any approval after 03:30 IST locks prompts for the rest of today.
    if (clock.totalMins >= 3 * 60 + 30) {
      this.state.tokenApprovedAfterResetIstDate = clock.istDateStr;
    }
    this.state.tokenPromptsSentIstDate = clock.istDateStr;
    this.state.tokenPromptSlotsSent = ['APPROVED'];
    this.persistState();
  }

  private async warmUpUniverseIfNeeded(istDateStr: string): Promise<void> {
    if (this.warmedUpIstDate === istDateStr || this.isWarmingUp || !getUpstoxAccessToken()) {
      return;
    }
    this.isWarmingUp = true;
    try {
      const toDate = istDateStr;
      const fromDt = new Date(Date.now() - 25 * 24 * 60 * 60 * 1000);
      const fromDate = fromDt.toISOString().slice(0, 10);

      let warmedCount = 0;
      for (const meta of NSE_UNIVERSE) {
        const daily = await fetchUpstoxHistoricalCandles(meta.symbol, 'days', 1, fromDate, toDate);
        if (daily.ok && daily.candles.length > 0) {
          const recentVols = daily.candles
            .slice(0, 10)
            .map((c) => Number(c[5] ?? 0))
            .filter((v) => v > 0);
          if (recentVols.length > 0) {
            const avgVol = recentVols.reduce((a, b) => a + b, 0) / recentVols.length;
            this.avgDailyVolumes.set(meta.symbol, avgVol);
          }
        }

        const intraday = await fetchUpstoxIntradayCandles(meta.symbol, 'minutes', 5);
        if (intraday.ok && intraday.candles.length > 0) {
          const closes = intraday.candles
            .slice(0, 40)
            .reverse()
            .map((c) => Number(c[4] ?? 0))
            .filter((c) => c > 0);
          if (closes.length > 0) {
            this.priceHistories.set(meta.symbol, closes);
            this.lastBarPushMs.set(meta.symbol, Date.now());
            warmedCount += 1;
          }
        } else if (daily.ok && daily.candles.length > 0 && !this.priceHistories.has(meta.symbol)) {
          const dailyCloses = daily.candles
            .slice(0, 25)
            .reverse()
            .map((c) => Number(c[4] ?? 0))
            .filter((c) => c > 0);
          if (dailyCloses.length > 0) {
            this.priceHistories.set(meta.symbol, dailyCloses);
            warmedCount += 1;
          }
        }
      }
      if (warmedCount >= 6) {
        this.warmedUpIstDate = istDateStr;
      }
    } catch {
      // Transient warmup errors will be retried on next session check
    } finally {
      this.isWarmingUp = false;
    }
  }

  private maybeSendScheduledTokenPrompt(): void {
    const redirectHint = `${process.env.APP_URL || ''} ${process.env.UPSTOX_REDIRECT_URI || ''}`;
    const behindAiStudioProxy = redirectHint.includes('ais-dev-');
    const allowAutoWhatsApp =
      process.env.UPSTOX_PUBLIC_WEBHOOK === 'true' || !behindAiStudioProxy;

    if (!allowAutoWhatsApp || !process.env.UPSTOX_API_KEY || !process.env.UPSTOX_API_SECRET) {
      return;
    }

    const clock = this.getIstClock();
    // Already approved after today's 03:30 IST reset -> zero repeat messages!
    if (this.state.tokenApprovedAfterResetIstDate === clock.istDateStr) {
      return;
    }

    if (this.state.tokenPromptsSentIstDate !== clock.istDateStr) {
      this.state.tokenPromptsSentIstDate = clock.istDateStr;
      this.state.tokenPromptSlotsSent = [];
    }
    const sentSlots = this.state.tokenPromptSlotsSent ?? [];
    if (sentSlots.includes('APPROVED')) {
      return;
    }

    // Wait quietly after 03:30 AM reset until 04:00 AM IST; send 1 prompt at 04:00, optional 1 nudge at 05:00 if unapproved, and 1 pre-market fallback at >=08:45 ONLY if still unapproved.
    let slot: string | null = null;
    if (clock.totalMins >= 240 && clock.totalMins < 300) {
      slot = '0400';
    } else if (clock.totalMins >= 300 && clock.totalMins < 525) {
      slot = '0500';
    } else if (clock.totalMins >= 525 && clock.totalMins <= 930) {
      slot = '0845';
    }

    if (!slot || sentSlots.includes(slot)) {
      return;
    }

    this.state.tokenPromptSlotsSent = [...sentSlots, slot];
    this.lastNotifierPromptMs = Date.now();
    this.state.lastNotifierPromptAtMs = this.lastNotifierPromptMs;
    this.persistState();

    const label =
      slot === '0400'
        ? '04:00 AM IST Daily Approval'
        : slot === '0500'
          ? '05:00 AM IST Reminder (Still Unapproved)'
          : 'Pre-Market Token Approval Needed';

    void requestUpstoxAccessTokenViaNotifier();
    void sendTelegramAlert(
      `${label}: Upstox 24h token reset at 03:30 AM. Tap Approve on your Upstox WhatsApp/App notification once—zero repeat alerts after approval.`
    );
  }

  private handleExpiredUpstoxToken(errMsg: string): void {
    this.state.upstoxAccountError = errMsg;
    const redirectHint = `${process.env.APP_URL || ''} ${process.env.UPSTOX_REDIRECT_URI || ''}`;
    const behindAiStudioProxy = redirectHint.includes('ais-dev-');
    const allowAutoWhatsApp =
      process.env.UPSTOX_PUBLIC_WEBHOOK === 'true' || !behindAiStudioProxy;

    if (this.state.status !== 'DEADMAN_LOCK' && this.state.status !== 'HALTED_DAILY_LOSS') {
      this.state.status = 'AWAITING_UPSTOX_TOKEN';
      this.state.statusReason = allowAutoWhatsApp
        ? 'Upstox 24h token expired; scheduled 04:00–05:00 IST WhatsApp/Upstox prompt arms automatically (or send /prompt).'
        : 'Upstox 24h token expired; click 1-Tap Upstox Login (opens Upstox login in a new tab to connect instantly).';
    }

    this.maybeSendScheduledTokenPrompt();
    this.persistState();
  }

  public async syncUpstoxAccountAndQuotes(): Promise<{
    ok: boolean;
    updatedCount: number;
    error?: string;
  }> {
    const token = getUpstoxAccessToken();
    if (!token) {
      this.handleExpiredUpstoxToken('Upstox daily access token not active on server.');
      return { ok: false, updatedCount: 0, error: this.state.upstoxAccountError ?? undefined };
    }

    // 1. Check live ₹ balance in Upstox SEC equity segment (Upstox Funds API sleeps 00:00–05:30 IST)
    let fundsMaintenance = false;
    const funds = await fetchUpstoxFunds();
    if (funds.ok && typeof funds.availableMarginInr === 'number') {
      const prevAvail = this.state.upstoxLiveBalanceInr;
      const liveAvail = round2(funds.availableMarginInr);
      const liveUsed = round2(funds.usedMarginInr ?? 0);
      const liveTotal = round2(liveAvail + liveUsed);
      this.state.upstoxLiveBalanceInr = liveAvail;
      this.state.upstoxAccountError = null;
      this.state.upstoxLastSyncAt = new Date().toISOString();

      // Always reflect exact live Upstox equity (deposits/withdrawals appear within 3-15s)
      if (this.state.positions.length === 0) {
        this.state.guardrails.allocatedCapitalInr = liveTotal;
        this.state.initialCapitalInr = round2(liveTotal - this.state.realizedPnlInr);
        if (this.state.trades.length === 0 || liveTotal > this.state.peakEquityInr) {
          this.state.peakEquityInr = liveTotal;
        }
        if (this.state.equityCurve.length <= 1) {
          this.state.equityCurve = [
            {
              timestamp: this.state.upstoxLastSyncAt,
              label: 'Live',
              equityInr: liveTotal,
              drawdownPct: 0,
              survivalFloorInr: computeSurvivalFloor(
                this.state.peakEquityInr,
                this.state.guardrails.maxTotalDrawdownPct
              ),
            },
          ];
        }
      }

      if (prevAvail === null || Math.abs(liveAvail - prevAvail) >= 1) {
        void sendTelegramAlert(
          `Upstox Live Balance Synced: Available ₹${liveAvail.toLocaleString('en-IN')} | Total Equity ₹${liveTotal.toLocaleString('en-IN')}`
        );
      }
    } else if (!funds.ok) {
      const errMsg = funds.error || 'Upstox funds check failed.';
      if (
        errMsg.includes('401') ||
        errMsg.toLowerCase().includes('token') ||
        errMsg.toLowerCase().includes('unauthorized')
      ) {
        this.handleExpiredUpstoxToken(errMsg);
        return { ok: false, updatedCount: 0, error: errMsg };
      }
      fundsMaintenance =
        errMsg.toLowerCase().includes('service hours') || errMsg.includes('5:30 AM');
      if (!fundsMaintenance) {
        this.state.upstoxAccountError = errMsg;
      }
    }

    // 2. Fetch live NSE_EQ quotes from Upstox
    const symbols = this.state.tickers.map((t) => t.symbol);
    const quoteRes = await fetchUpstoxNseQuotes(symbols);
    if (!quoteRes.ok) {
      const qErr = quoteRes.error || 'Upstox quote sync failed.';
      if (
        qErr.includes('401') ||
        qErr.toLowerCase().includes('token') ||
        qErr.toLowerCase().includes('unauthorized')
      ) {
        this.handleExpiredUpstoxToken(qErr);
        return { ok: false, updatedCount: 0, error: qErr };
      }
      this.state.upstoxAccountError = qErr;
      this.persistState();
      return { ok: false, updatedCount: 0, error: quoteRes.error };
    }

    // Quotes succeeded -> Upstox token & live market feed are confirmed active (clear any transient network error)
    if (quoteRes.quotes.length > 0) {
      if (funds.ok || fundsMaintenance || this.state.upstoxLiveBalanceInr !== null) {
        this.state.upstoxAccountError = null;
      }
      const clock = this.getIstClock();
      if (clock.totalMins >= 3 * 60 + 30) {
        this.state.tokenApprovedAfterResetIstDate = clock.istDateStr;
      }
    }

    for (const q of quoteRes.quotes) {
      await this.ingestExternalTick({
        symbol: q.symbol,
        ltp: q.ltp,
        open: q.open,
        high: q.high,
        low: q.low,
        prevClose: q.prevClose,
        vwap: q.vwap,
        volume: q.volume,
        skipPersist: true,
      });
    }

    // 2b. Sync real NIFTY 50 & India VIX from Upstox
    const idxSnap = await fetchUpstoxIndexSnapshots();
    if (idxSnap.ok) {
      if (idxSnap.nifty50) this.state.nifty50 = round2(idxSnap.nifty50);
      if (idxSnap.niftyPrevClose) this.state.niftyBase = round2(idxSnap.niftyPrevClose);
      if (idxSnap.indiaVix) this.state.indiaVix = round2(idxSnap.indiaVix);
    }

    // 2c. Update mark-to-market for any live CE/PE option position
    for (const pos of this.state.positions) {
      if (
        pos.instrumentKey &&
        (pos.instrumentType === 'OPTION_CE' || pos.instrumentType === 'OPTION_PE')
      ) {
        const optQ = await fetchUpstoxSingleQuote(pos.instrumentKey);
        if (optQ.ok && optQ.ltp && optQ.ltp > 0) {
          this.updateOptionPositionMarkToMarket(pos.id, optQ.ltp);
        }
      }
    }

    // 3. Self-healing live broker position reconciliation (matches both equity symbol and option instrumentKey)
    if (this.state.positions.length > 0) {
      const livePosRes = await fetchUpstoxPositions();
      if (livePosRes.ok) {
        const activeKeys = new Set<string>();
        for (const p of livePosRes.positions) {
          if (p.quantity > 0) {
            if (p.symbol) activeKeys.add(p.symbol.toUpperCase());
            if (p.instrumentToken) activeKeys.add(p.instrumentToken);
          }
        }
        const orphanPositions = this.state.positions.filter(
          (p) =>
            !activeKeys.has(p.symbol.toUpperCase()) &&
            !(p.instrumentKey && activeKeys.has(p.instrumentKey))
        );
        for (const orphan of orphanPositions) {
          this.reconcileClosedPosition(orphan.id, 'SIGNAL_EXIT');
        }
      }
    }

    this.state.upstoxLastSyncAt = new Date().toISOString();
    this.persistState();
    return { ok: true, updatedCount: quoteRes.quotes.length };
  }

  private computeEquityMetrics() {
    const unrealizedPnl = round2(
      this.state.positions.reduce((acc, p) => acc + p.unrealizedPnlInr, 0)
    );
    const currentEquity = round2(
      this.state.initialCapitalInr + this.state.realizedPnlInr + unrealizedPnl
    );
    const usedMargin = round2(
      this.state.positions.reduce((acc, p) => acc + p.entryPrice * p.qty, 0)
    );
    const availableMargin = round2(Math.max(0, currentEquity - usedMargin));
    const survivalFloor = computeSurvivalFloor(
      this.state.peakEquityInr,
      this.state.guardrails.maxTotalDrawdownPct,
      this.state.initialCapitalInr
    );
    const survivalBuffer = round2(currentEquity - survivalFloor);
    const survivalBufferPct =
      currentEquity > 0 ? round2((survivalBuffer / currentEquity) * 100) : 0;

    return {
      unrealizedPnl,
      currentEquity,
      usedMargin,
      availableMargin,
      survivalFloor,
      survivalBuffer,
      survivalBufferPct,
    };
  }

  public getSnapshot(): BotStateSnapshot {
    const brokers = getBrokerStatuses();
    const niftyChangePct =
      this.state.niftyBase > 0
        ? ((this.state.nifty50 - this.state.niftyBase) / this.state.niftyBase) * 100
        : 0;

    const session = getIstMarketSession(
      this.state.guardrails.autoSquareoffIst,
      this.state.nifty50,
      niftyChangePct,
      this.state.indiaVix,
      this.state.guardrails.vixThrottleThreshold
    );

    const eq = this.computeEquityMetrics();
    const wins = this.state.trades.filter((t) => t.netPnlInr > 0);
    const losses = this.state.trades.filter((t) => t.netPnlInr <= 0);
    const grossWin = wins.reduce((acc, t) => acc + t.netPnlInr, 0);
    const grossLoss = losses.reduce((acc, t) => acc + Math.abs(t.netPnlInr), 0);
    const profitFactor =
      grossLoss > 0 ? round2(grossWin / grossLoss) : grossWin > 0 ? 9.99 : 0;
    const winRatePct =
      this.state.trades.length > 0
        ? round2((wins.length / this.state.trades.length) * 100)
        : 0;

    return {
      status: this.state.status,
      activeBroker: 'upstox',
      tradingMode: 'live',
      upstoxConnected: Boolean(getUpstoxAccessToken()) && !this.state.upstoxAccountError,
      upstoxOAuthConfigured: Boolean(
        process.env.UPSTOX_API_KEY && process.env.UPSTOX_API_SECRET
      ),
      upstoxLiveBalanceInr: this.state.upstoxLiveBalanceInr,
      upstoxLastSyncAt: this.state.upstoxLastSyncAt,
      upstoxAccountError: this.state.upstoxAccountError,
      statusReason: this.state.statusReason,
      cooldownUntil: this.state.cooldownUntil,
      tickCount: this.state.tickCount,
      lastTickAt: this.state.lastTickAt,
      initialCapitalInr: this.state.initialCapitalInr,
      peakEquityInr: this.state.peakEquityInr,
      currentEquityInr: eq.currentEquity,
      availableMarginInr: eq.availableMargin,
      usedMarginInr: eq.usedMargin,
      survivalFloorInr: eq.survivalFloor,
      survivalBufferInr: eq.survivalBuffer,
      survivalBufferPct: eq.survivalBufferPct,
      dailyPnlInr: round2(this.state.dailyPnlInr + eq.unrealizedPnl),
      dailyPnlPct:
        this.state.initialCapitalInr > 0
          ? round2(
              ((this.state.dailyPnlInr + eq.unrealizedPnl) / this.state.initialCapitalInr) * 100
            )
          : 0,
      totalRealizedPnlInr: round2(this.state.realizedPnlInr),
      totalUnrealizedPnlInr: eq.unrealizedPnl,
      totalChargesPaidInr: round2(this.state.totalChargesPaidInr),
      consecutiveLosses: this.state.consecutiveLosses,
      winRatePct,
      profitFactor,
      maxDrawdownSeenPct: round2(this.state.maxDrawdownSeenPct),
      guardrails: this.state.guardrails,
      strategies: this.state.strategies,
      session,
      tickers: this.state.tickers,
      positions: this.state.positions,
      trades: this.state.trades.slice(0, 60),
      riskAudit: this.state.riskAudit.slice(0, 80),
      equityCurve: this.state.equityCurve.slice(-120),
      brokers,
      aiSupervisor: this.state.aiSupervisor,
      aiThrottleMultiplier: this.state.aiThrottleMultiplier,
      staticIp: this.staticIp,
      newsDigest: getCachedMarketNewsDigest(),
    };
  }

  public resumeAutonomous(): void {
    if (this.state.status === 'DEADMAN_LOCK' || this.state.status === 'HALTED_DAILY_LOSS') {
      return;
    }
    this.state.status = getUpstoxAccessToken()
      ? 'AWAITING_MARKET_OPEN'
      : 'AWAITING_UPSTOX_TOKEN';
    this.state.statusReason = 'Autonomous supervisor resumed.';
    this.persistState();
    void this.autonomousTick();
  }

  public pauseAutonomous(): void {
    if (
      this.state.status !== 'DEADMAN_LOCK' &&
      this.state.status !== 'HALTED_DAILY_LOSS'
    ) {
      this.state.status = 'PAUSED';
      this.state.statusReason = 'Autonomous entries paused by operator.';
      this.persistState();
    }
  }

  public async killSwitch(
    reason = 'Operator triggered Emergency Kill-Switch & flattened all live Upstox positions.'
  ): Promise<void> {
    await this.flattenAllPositions('KILL_SWITCH');
    this.state.status = 'DEADMAN_LOCK';
    this.state.statusReason = reason;
    this.addRiskAudit({
      symbol: 'PORTFOLIO',
      side: 'SELL',
      requestedQty: 0,
      approvedQty: 0,
      strategyId: 'ORB_VWAP',
      decision: 'CIRCUIT_BREAKER',
      rule: 'EMERGENCY_KILL_SWITCH',
      reason,
    });
    this.persistState();
  }

  public resetEngine(newCapitalInr?: number): void {
    const fresh = this.createInitialState();
    const targetCap =
      newCapitalInr !== undefined && newCapitalInr >= 0
        ? round2(newCapitalInr)
        : this.state.guardrails.allocatedCapitalInr;
    fresh.guardrails = { ...this.state.guardrails, allocatedCapitalInr: targetCap };
    fresh.initialCapitalInr = targetCap;
    fresh.peakEquityInr = targetCap;
    fresh.equityCurve[0].equityInr = targetCap;
    fresh.equityCurve[0].survivalFloorInr = computeSurvivalFloor(
      targetCap,
      fresh.guardrails.maxTotalDrawdownPct,
      targetCap
    );
    this.state = fresh;
    this.priceHistories.clear();
    this.recentOrderTimestamps = [];
    this.persistState();
    void this.syncUpstoxAccountAndQuotes();
  }

  public updateGuardrails(partial: Partial<GuardrailsConfig>): void {
    const prevCap = this.state.guardrails.allocatedCapitalInr;
    this.state.guardrails = {
      ...this.state.guardrails,
      ...partial,
      allocatedCapitalInr: Math.max(0, Number(partial.allocatedCapitalInr ?? prevCap)),
      maxDailyLossPct: Math.min(
        100,
        Math.max(0.5, Number(partial.maxDailyLossPct ?? this.state.guardrails.maxDailyLossPct))
      ),
      maxTotalDrawdownPct: Math.min(
        100,
        Math.max(
          1.0,
          Number(partial.maxTotalDrawdownPct ?? this.state.guardrails.maxTotalDrawdownPct)
        )
      ),
      riskPerTradePct: Math.min(
        25.0,
        Math.max(0.5, Number(partial.riskPerTradePct ?? this.state.guardrails.riskPerTradePct))
      ),
      maxOpenPositions: Math.min(
        12,
        Math.max(1, Math.round(Number(partial.maxOpenPositions ?? this.state.guardrails.maxOpenPositions)))
      ),
      maxSingleStockWeightPct: Math.min(
        100,
        Math.max(
          10,
          Number(
            partial.maxSingleStockWeightPct ?? this.state.guardrails.maxSingleStockWeightPct
          )
        )
      ),
      maxSectorPositions: Math.min(
        6,
        Math.max(
          1,
          Math.round(Number(partial.maxSectorPositions ?? this.state.guardrails.maxSectorPositions))
        )
      ),
      maxOrdersPerMinute: Math.min(
        30,
        Math.max(
          1,
          Math.round(Number(partial.maxOrdersPerMinute ?? this.state.guardrails.maxOrdersPerMinute))
        )
      ),
      vixThrottleThreshold: Math.min(
        35,
        Math.max(
          11,
          Number(partial.vixThrottleThreshold ?? this.state.guardrails.vixThrottleThreshold)
        )
      ),
    };

    if (this.state.trades.length === 0 && this.state.positions.length === 0) {
      this.state.initialCapitalInr = this.state.guardrails.allocatedCapitalInr;
      this.state.peakEquityInr = this.state.guardrails.allocatedCapitalInr;
      if (this.state.equityCurve.length > 0) {
        this.state.equityCurve[0].equityInr = this.state.guardrails.allocatedCapitalInr;
        this.state.equityCurve[0].survivalFloorInr = computeSurvivalFloor(
          this.state.peakEquityInr,
          this.state.guardrails.maxTotalDrawdownPct,
          this.state.initialCapitalInr
        );
      }
    }
    this.persistState();
  }

  public updateStrategy(
    id: StrategyId,
    updates: Partial<
      Pick<
        StrategyConfig,
        'enabled' | 'capitalWeightPct' | 'minConfidence' | 'stopLossAtrMult' | 'targetAtrMult'
      >
    >
  ): void {
    this.state.strategies = this.state.strategies.map((s) =>
      s.id === id ? { ...s, ...updates } : s
    );
    this.persistState();
  }

  public setAiAutoApply(enabled: boolean): void {
    this.state.aiAutoApply = enabled;
    if (this.state.aiSupervisor) {
      this.state.aiSupervisor.autoApplyEnabled = enabled;
    }
    if (!enabled) {
      this.state.aiThrottleMultiplier = 1.0;
    } else if (this.state.aiSupervisor) {
      this.state.aiThrottleMultiplier = this.state.aiSupervisor.recommendedThrottle;
    }
    this.persistState();
  }

  public async triggerAiSupervisor(): Promise<AiSupervisorReport> {
    const snapshot = this.getSnapshot();
    const report = await runAiMarketSupervisor(snapshot, this.state.aiAutoApply);
    this.state.aiSupervisor = report;
    this.lastAiRunMs = Date.now();
    if (this.state.aiAutoApply) {
      this.state.aiThrottleMultiplier =
        report.regimeAssessment === 'STAND_DOWN' ? 0.25 : report.recommendedThrottle;
    }
    this.addRiskAudit({
      symbol: 'AI_SUPERVISOR',
      side: 'BUY',
      requestedQty: 0,
      approvedQty: 0,
      strategyId: 'ORB_VWAP',
      decision: report.regimeAssessment === 'STAND_DOWN' ? 'THROTTLED' : 'APPROVED',
      rule: `SUPERVISOR_${report.regimeAssessment}`,
      reason: `${report.model}: regime=${report.regimeAssessment}, throttle=${report.recommendedThrottle}x, vetoed=[${report.vetoedSymbols.join(', ') || 'none'}]`,
    });
    this.persistState();
    return report;
  }

  public async refreshStaticIp(): Promise<StaticIpInfo> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const resp = await fetch('https://api.ipify.org?format=json', {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (resp.ok) {
        const data = (await resp.json()) as { ip?: string };
        this.staticIp = {
          serverOutboundIp: data.ip || null,
          checkedAt: new Date().toISOString(),
          sebiWhitelistReady: Boolean(data.ip),
          webhookEndpoint: '/api/market-data/tick',
          notes:
            'Whitelist this static outbound IP in your Upstox Developer Console under SEBI algo static-IP rules.',
        };
      }
    } catch {
      this.staticIp = {
        ...this.staticIp,
        checkedAt: new Date().toISOString(),
        notes:
          'Outbound IP lookup blocked in sandbox; deploy on your AWS Elastic IP VPS and run curl ifconfig.me.',
      };
    }
    return this.staticIp;
  }

  public async checkUpstoxFunds() {
    const res = await fetchUpstoxFunds();
    if (res.ok && typeof res.availableMarginInr === 'number') {
      const liveAvail = round2(res.availableMarginInr);
      const liveUsed = round2(res.usedMarginInr ?? 0);
      const liveTotal = round2(liveAvail + liveUsed);
      this.state.upstoxLiveBalanceInr = liveAvail;
      this.state.upstoxAccountError = null;
      this.state.upstoxLastSyncAt = new Date().toISOString();
      if (this.state.positions.length === 0) {
        this.state.guardrails.allocatedCapitalInr = liveTotal;
        this.state.initialCapitalInr = round2(liveTotal - this.state.realizedPnlInr);
        if (this.state.trades.length === 0 || liveTotal > this.state.peakEquityInr) {
          this.state.peakEquityInr = liveTotal;
        }
      }
      this.persistState();
    }
    return res;
  }

  public async syncNseCalendar() {
    return refreshNseOfficialHolidays();
  }

  public async ingestExternalTick(input: {
    symbol: string;
    ltp: number;
    open?: number;
    high?: number;
    low?: number;
    prevClose?: number;
    vwap?: number;
    rvol?: number;
    volume?: number;
    skipPersist?: boolean;
  }): Promise<{ ok: boolean; error?: string }> {
    const idx = this.state.tickers.findIndex(
      (t) => t.symbol.toUpperCase() === input.symbol.toUpperCase()
    );
    if (idx === -1) {
      return { ok: false, error: `Symbol ${input.symbol} not in configured NSE universe.` };
    }
    const ticker = this.state.tickers[idx];
    const nextLtp = round2(Number(input.ltp));
    if (!Number.isFinite(nextLtp) || nextLtp <= 0) {
      return { ok: false, error: 'Invalid LTP price.' };
    }

    const hist = this.priceHistories.get(ticker.symbol) || [
      input.prevClose && input.prevClose > 0 ? input.prevClose : nextLtp,
    ];
    const nowMs = Date.now();
    const lastPush = this.lastBarPushMs.get(ticker.symbol) ?? 0;
    // Sample candle history once per 60s so EMA9/EMA21/RSI reflect multi-minute structure, not 3s tick noise
    if (nowMs - lastPush >= 60_000 || hist.length < 2) {
      hist.push(nextLtp);
      if (hist.length > 40) hist.shift();
      this.lastBarPushMs.set(ticker.symbol, nowMs);
    }
    this.priceHistories.set(ticker.symbol, hist);

    const prevClose =
      input.prevClose && input.prevClose > 0
        ? round2(input.prevClose)
        : ticker.prevClose > 0
          ? ticker.prevClose
          : nextLtp;
    const open =
      input.open && input.open > 0
        ? round2(input.open)
        : ticker.open > 0
          ? ticker.open
          : nextLtp;
    const high = Math.max(ticker.high || nextLtp, input.high ?? nextLtp);
    const low = ticker.low > 0 ? Math.min(ticker.low, input.low ?? nextLtp) : input.low ?? nextLtp;
    const atr14 = round2(Math.max(nextLtp * 0.008, (high - low) * 0.7));

    let computedRvol = ticker.rvol;
    if (input.rvol && input.rvol > 0) {
      computedRvol = round2(input.rvol);
    } else if (input.volume && input.volume > 0) {
      const avgVol = this.avgDailyVolumes.get(ticker.symbol);
      if (avgVol && avgVol > 0) {
        const sessionFrac = this.getIstSessionFraction();
        computedRvol = round2(
          Math.min(6.0, Math.max(0.25, input.volume / (avgVol * sessionFrac)))
        );
      } else {
        const rangePct = nextLtp > 0 ? ((high - low) / nextLtp) * 100 : 0;
        computedRvol = round2(Math.min(3.5, Math.max(0.8, rangePct / 1.1)));
      }
    }

    const evalSeries = hist.length > 0 ? [...hist.slice(0, -1), nextLtp] : [nextLtp];

    const updated = this.recomputeIndicators(
      {
        ...ticker,
        ltp: nextLtp,
        open,
        high,
        low,
        prevClose,
        atr14,
        vwap:
          input.vwap && input.vwap > 0
            ? round2(input.vwap)
            : ticker.vwap > 0
              ? round2(ticker.vwap * 0.85 + nextLtp * 0.15)
              : nextLtp,
        rvol: computedRvol,
        lastQuoteAt: new Date().toISOString(),
      },
      evalSeries
    );

    this.state.tickers[idx] = this.evaluateSignalForTicker(updated);
    this.updatePositionsMarkToMarket();
    if (!input.skipPersist) {
      this.persistState();
    }
    return { ok: true };
  }

  private recomputeIndicators(
    ticker: MarketTickerSnapshot,
    hist: number[]
  ): MarketTickerSnapshot {
    const changePct =
      ticker.prevClose > 0
        ? round2(((ticker.ltp - ticker.prevClose) / ticker.prevClose) * 100)
        : 0;
    const n = hist.length;
    const mean = hist.reduce((a, b) => a + b, 0) / Math.max(1, n);
    const variance =
      hist.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / Math.max(1, n);
    const std = Math.max(0.01, Math.sqrt(variance));
    const zScore = round2((ticker.ltp - mean) / std);

    let ema9Val = hist[0] ?? ticker.ltp;
    let ema21Val = hist[0] ?? ticker.ltp;
    const k9 = 2 / (9 + 1);
    const k21 = 2 / (21 + 1);
    for (let i = 1; i < hist.length; i++) {
      ema9Val = hist[i] * k9 + ema9Val * (1 - k9);
      ema21Val = hist[i] * k21 + ema21Val * (1 - k21);
    }

    let gains = 0;
    let losses = 0;
    const rsiSlice = hist.slice(-15);
    for (let i = 1; i < rsiSlice.length; i++) {
      const diff = rsiSlice[i] - rsiSlice[i - 1];
      if (diff >= 0) gains += diff;
      else losses += Math.abs(diff);
    }
    const rs = losses > 0 ? gains / losses : gains > 0 ? 100 : 1;
    const rsi14 = round2(100 - 100 / (1 + rs));

    return {
      ...ticker,
      changePct,
      zScore,
      ema9: round2(ema9Val),
      ema21: round2(ema21Val),
      rsi14,
    };
  }

  private evaluateSignalForTicker(t: MarketTickerSnapshot): MarketTickerSnapshot {
    if (t.ltp <= 0 || t.vwap <= 0) return t;
    let signal: StrategyId | null = null;
    let signalSide: OrderSide | null = null;
    let signalConfidence = 0;

    // STRICT LONG-ONLY (BUY entries only; never short sell)
    if (
      t.rvol >= 1.05 &&
      t.ltp > t.vwap &&
      t.ltp >= (t.open > 0 ? t.open * 0.999 : t.prevClose) &&
      t.ema9 >= t.ema21 &&
      t.rsi14 >= 51 &&
      t.rsi14 <= 74
    ) {
      signal = 'ORB_VWAP';
      signalSide = 'BUY';
      signalConfidence = Math.min(94, Math.round(62 + Math.max(0, t.rvol - 1.0) * 30));
    } else if (
      (t.zScore <= -1.25 || (t.ltp < t.vwap * 0.992 && t.rsi14 <= 44)) &&
      t.rsi14 <= 46 &&
      (t.prevClose <= 0 || t.ltp >= t.prevClose * 0.96) &&
      (t.low <= 0 || t.ltp >= t.low * 1.001)
    ) {
      signal = 'MEAN_REVERSION';
      signalSide = 'BUY';
      signalConfidence = Math.min(92, Math.round(58 + Math.max(0.5, Math.abs(t.zScore)) * 15));
    } else {
      const pairMap: Record<string, string> = {
        HDFCBANK: 'ICICIBANK',
        ICICIBANK: 'HDFCBANK',
        INFY: 'TCS',
        TCS: 'INFY',
        SBIN: 'AXISBANK',
        AXISBANK: 'SBIN',
      };
      const peerSym = pairMap[t.symbol];
      if (peerSym) {
        const peer = this.state.tickers.find((p) => p.symbol === peerSym);
        if (peer && peer.ltp > 0 && peer.changePct > -0.4 && t.rsi14 < 62) {
          const spreadPct = t.changePct - peer.changePct;
          if (spreadPct <= -0.35) {
            signal = 'PAIRS_SPREAD';
            signalSide = 'BUY';
            signalConfidence = Math.min(90, Math.round(60 + Math.abs(spreadPct) * 24));
          }
        }
      }
    }

    if (signal && signalConfidence > 0) {
      const news = getCachedMarketNewsDigest();
      const symNews = news.symbolBias[t.symbol];
      if (symNews) {
        signalConfidence = Math.max(25, Math.min(96, signalConfidence + symNews.score * 2));
      } else if (news.macroScore >= 2) {
        signalConfidence = Math.min(96, signalConfidence + 2);
      } else if (news.macroScore <= -3) {
        signalConfidence = Math.max(30, signalConfidence - 3);
      }
    }

    return {
      ...t,
      signal,
      signalSide,
      signalConfidence,
    };
  }

  private updateOptionPositionMarkToMarket(positionId: string, optionLtp: number): void {
    this.state.positions = this.state.positions.map((pos) => {
      if (pos.id !== positionId) return pos;
      const unrealizedPnlInr = round2(
        (optionLtp - pos.entryPrice) * pos.qty - pos.entryChargesInr
      );
      let trailingStop = pos.trailingStop;
      const feeBufferPerUnit = (pos.entryChargesInr * 2.2) / Math.max(1, pos.qty);
      if (unrealizedPnlInr >= pos.riskAmountInr * 1.25 && optionLtp > pos.entryPrice) {
        const lockHalfGain = pos.entryPrice + (optionLtp - pos.entryPrice) * 0.5;
        const trailCandidate = round2(
          Math.max(pos.entryPrice + feeBufferPerUnit, lockHalfGain, optionLtp * 0.9)
        );
        trailingStop =
          trailingStop === null ? trailCandidate : Math.max(trailingStop, trailCandidate);
      } else if (unrealizedPnlInr >= pos.riskAmountInr * 0.6) {
        const trailCandidate = round2(
          Math.max(pos.entryPrice + feeBufferPerUnit, optionLtp * 0.88)
        );
        trailingStop =
          trailingStop === null ? trailCandidate : Math.max(trailingStop, trailCandidate);
      }
      return {
        ...pos,
        currentPrice: round2(optionLtp),
        unrealizedPnlInr,
        trailingStop,
      };
    });
  }

  private updatePositionsMarkToMarket(): void {
    this.state.positions = this.state.positions.map((pos) => {
      if (pos.instrumentType === 'OPTION_CE' || pos.instrumentType === 'OPTION_PE') {
        return pos;
      }
      const ticker = this.state.tickers.find((t) => t.symbol === pos.symbol);
      if (!ticker || ticker.ltp <= 0) return pos;
      const diff =
        pos.side === 'BUY'
          ? ticker.ltp - pos.entryPrice
          : pos.entryPrice - ticker.ltp;
      const unrealizedPnlInr = round2(diff * pos.qty - pos.entryChargesInr);

      let trailingStop = pos.trailingStop;
      const feeBufferPerUnit = (pos.entryChargesInr * 2.2) / Math.max(1, pos.qty);
      if (unrealizedPnlInr >= pos.riskAmountInr * 1.25 && pos.side === 'BUY' && ticker.ltp > pos.entryPrice) {
        const lockHalfGain = pos.entryPrice + (ticker.ltp - pos.entryPrice) * 0.55;
        const trailCandidate = round2(
          Math.max(pos.entryPrice + feeBufferPerUnit, lockHalfGain, ticker.ltp - ticker.atr14 * 0.55)
        );
        trailingStop =
          trailingStop === null ? trailCandidate : Math.max(trailingStop, trailCandidate);
      } else if (unrealizedPnlInr >= pos.riskAmountInr * 0.6) {
        const trailCandidate =
          pos.side === 'BUY'
            ? round2(
                Math.max(pos.entryPrice + feeBufferPerUnit, ticker.ltp - ticker.atr14 * 0.7)
              )
            : round2(
                Math.min(pos.entryPrice - feeBufferPerUnit, ticker.ltp + ticker.atr14 * 0.7)
              );
        if (trailingStop === null) {
          trailingStop = trailCandidate;
        } else {
          trailingStop =
            pos.side === 'BUY'
              ? Math.max(trailingStop, trailCandidate)
              : Math.min(trailingStop, trailCandidate);
        }
      }

      return {
        ...pos,
        currentPrice: ticker.ltp,
        unrealizedPnlInr,
        trailingStop,
      };
    });
  }

  private async manageOpenPositionsAndBreakers(isSquareoffWindow: boolean): Promise<boolean> {
    const toClose: Array<{ pos: Position; reason: TradeRecord['exitReason'] }> = [];

    for (const pos of this.state.positions) {
      if (isSquareoffWindow && pos.productType === 'MIS') {
        toClose.push({ pos, reason: 'SQUAREOFF_1515' });
        continue;
      }

      const activeStop = pos.trailingStop ?? pos.stopLoss;
      if (pos.side === 'BUY') {
        if (pos.currentPrice <= activeStop) {
          toClose.push({
            pos,
            reason: pos.trailingStop !== null ? 'TRAILING_STOP' : 'STOP_LOSS',
          });
        } else if (pos.currentPrice >= pos.takeProfit) {
          toClose.push({ pos, reason: 'TAKE_PROFIT' });
        }
      } else {
        if (pos.currentPrice >= activeStop) {
          toClose.push({
            pos,
            reason: pos.trailingStop !== null ? 'TRAILING_STOP' : 'STOP_LOSS',
          });
        } else if (pos.currentPrice <= pos.takeProfit) {
          toClose.push({ pos, reason: 'TAKE_PROFIT' });
        }
      }
    }

    for (const item of toClose) {
      await this.closePosition(item.pos.id, item.reason);
    }

    const eq = this.computeEquityMetrics();
    if (eq.currentEquity > this.state.peakEquityInr) {
      this.state.peakEquityInr = eq.currentEquity;
    }

    const ddPct =
      this.state.peakEquityInr > 0
        ? ((this.state.peakEquityInr - eq.currentEquity) / this.state.peakEquityInr) * 100
        : 0;
    if (ddPct > this.state.maxDrawdownSeenPct) {
      this.state.maxDrawdownSeenPct = round2(ddPct);
    }

    const hasSyncedCapital =
      this.state.upstoxLiveBalanceInr !== null || this.state.initialCapitalInr > 0;
    if (
      hasSyncedCapital &&
      (eq.currentEquity <= 0 || (eq.survivalFloor > 0 && eq.currentEquity <= eq.survivalFloor))
    ) {
      await this.flattenAllPositions('KILL_SWITCH');
      this.state.status = 'DEADMAN_LOCK';
      this.state.statusReason = `SURVIVAL FLOOR BREACHED: Equity ₹${eq.currentEquity.toFixed(0)} <= ₹${eq.survivalFloor.toFixed(0)}. Engine locked.`;
      this.addRiskAudit({
        symbol: 'PORTFOLIO',
        side: 'SELL',
        requestedQty: 0,
        approvedQty: 0,
        strategyId: 'ORB_VWAP',
        decision: 'CIRCUIT_BREAKER',
        rule: 'SURVIVAL_FLOOR_DEADMAN_LOCK',
        reason: this.state.statusReason,
      });
      void sendTelegramAlert(`DEADMAN LOCK TRIGGERED: ${this.state.statusReason}`);
      return false;
    }

    if (this.state.guardrails.maxDailyLossPct < 100 && hasSyncedCapital) {
      const maxDailyLossInr =
        eq.currentEquity * (this.state.guardrails.maxDailyLossPct / 100);
      const totalDailyPnl = this.state.dailyPnlInr + eq.unrealizedPnl;
      if (totalDailyPnl <= -maxDailyLossInr) {
        await this.flattenAllPositions('KILL_SWITCH');
        this.state.status = 'HALTED_DAILY_LOSS';
        this.state.statusReason = `DAILY LOSS CAP HIT: ₹${totalDailyPnl.toFixed(0)} exceeded -${this.state.guardrails.maxDailyLossPct}% limit.`;
        this.addRiskAudit({
          symbol: 'PORTFOLIO',
          side: 'SELL',
          requestedQty: 0,
          approvedQty: 0,
          strategyId: 'ORB_VWAP',
          decision: 'CIRCUIT_BREAKER',
          rule: 'DAILY_LOSS_LIMIT_HALT',
          reason: this.state.statusReason,
        });
        void sendTelegramAlert(`DAILY LOSS HALT: ${this.state.statusReason}`);
        return false;
      }
    }

    return true;
  }

  private reconcileClosedPosition(
    positionId: string,
    exitReason: TradeRecord['exitReason']
  ): void {
    const idx = this.state.positions.findIndex((p) => p.id === positionId);
    if (idx === -1) return;
    const pos = this.state.positions[idx];
    const exitPrice = pos.currentPrice;
    const instType: InstrumentType = pos.instrumentType || 'EQUITY';
    const exitCharges = calculateIndianTransactionCosts(
      exitPrice,
      pos.qty,
      'SELL',
      pos.productType,
      instType
    ).totalChargesInr;

    const grossPnlInr = round2((exitPrice - pos.entryPrice) * pos.qty);
    const totalCharges = round2(pos.entryChargesInr + exitCharges);
    const netPnlInr = round2(grossPnlInr - totalCharges);

    this.state.positions.splice(idx, 1);
    this.state.realizedPnlInr = round2(this.state.realizedPnlInr + netPnlInr);
    this.state.dailyPnlInr = round2(this.state.dailyPnlInr + netPnlInr);
    this.state.totalChargesPaidInr = round2(this.state.totalChargesPaidInr + totalCharges);

    const recTrade: TradeRecord = {
      id: `TRD-REC-${Date.now()}`,
      symbol: pos.symbol,
      instrumentType: instType,
      sector: pos.sector,
      side: pos.side,
      qty: pos.qty,
      entryPrice: pos.entryPrice,
      exitPrice,
      strategyId: pos.strategyId,
      productType: pos.productType,
      grossPnlInr,
      chargesInr: totalCharges,
      netPnlInr,
      exitReason,
      openedAt: pos.openedAt,
      closedAt: new Date().toISOString(),
    };
    this.state.trades.unshift(recTrade);
    this.appendTradeHistoryLog(recTrade);
    this.adaptStrategyFromClosedTrade(pos.strategyId);
  }

  private appendTradeHistoryLog(trade: TradeRecord): void {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      fs.appendFileSync(TRADE_HISTORY_FILE, `${JSON.stringify(trade)}\n`, 'utf-8');
    } catch {
      // Non-fatal disk append
    }
  }

  public getTradeHistory(limit = 300): TradeRecord[] {
    const merged = new Map<string, TradeRecord>();
    try {
      if (fs.existsSync(TRADE_HISTORY_FILE)) {
        const lines = fs.readFileSync(TRADE_HISTORY_FILE, 'utf-8').split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const parsed = JSON.parse(trimmed) as TradeRecord;
            if (parsed?.id) merged.set(parsed.id, parsed);
          } catch {
            // Skip malformed line
          }
        }
      }
    } catch {
      // Fallback to in-memory state
    }
    for (const tr of this.state.trades) {
      merged.set(tr.id, tr);
    }
    return Array.from(merged.values())
      .sort((a, b) => new Date(b.closedAt).getTime() - new Date(a.closedAt).getTime())
      .slice(0, limit);
  }

  private getTodayTradedSymbols(): string[] {
    const todayIst = this.getIstClock().istDateStr;
    const set = new Set<string>();
    for (const p of this.state.positions) {
      set.add(p.symbol);
    }
    for (const tr of this.state.trades) {
      const trIst = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(tr.closedAt));
      if (trIst === todayIst) {
        set.add(tr.symbol);
      }
    }
    return Array.from(set);
  }

  private adaptStrategyFromClosedTrade(strategyId: StrategyId): void {
    const strat = this.state.strategies.find((s) => s.id === strategyId);
    if (!strat || strat.tradesCount < 3) return;

    const recentForStrat = this.state.trades
      .filter((t) => t.strategyId === strategyId)
      .slice(0, 5);
    const recentNet = recentForStrat.reduce((acc, t) => acc + t.netPnlInr, 0);
    const winRate = strat.winCount / Math.max(1, strat.tradesCount);

    let nextConf = strat.minConfidence;
    let nextWeight = strat.capitalWeightPct;

    if (recentNet < 0 && winRate < 0.42) {
      nextConf = Math.min(82, strat.minConfidence + 2);
      nextWeight = Math.max(15, strat.capitalWeightPct - 4);
    } else if (recentNet > 0 && winRate >= 0.55) {
      nextConf = Math.max(54, strat.minConfidence - 1);
      nextWeight = Math.min(65, strat.capitalWeightPct + 4);
    }

    if (nextConf !== strat.minConfidence || nextWeight !== strat.capitalWeightPct) {
      this.state.strategies = this.state.strategies.map((s) =>
        s.id === strategyId
          ? { ...s, minConfidence: nextConf, capitalWeightPct: nextWeight }
          : s
      );
      this.addRiskAudit({
        symbol: strategyId,
        side: 'BUY',
        requestedQty: 0,
        approvedQty: 0,
        strategyId,
        decision: 'APPROVED',
        rule: 'SELF_LEARNING_TUNE',
        reason: `Self-learning updated ${strategyId}: minConf ${strat.minConfidence}->${nextConf}, weight ${strat.capitalWeightPct}%->${nextWeight}% (${strat.winCount}/${strat.tradesCount} wins).`,
      });
    }
  }

  private async closePosition(
    positionId: string,
    exitReason: TradeRecord['exitReason']
  ): Promise<void> {
    const idx = this.state.positions.findIndex((p) => p.id === positionId);
    if (idx === -1) return;
    const pos = this.state.positions[idx];
    const exitSide: OrderSide = pos.side === 'BUY' ? 'SELL' : 'BUY';
    const instType: InstrumentType = pos.instrumentType || 'EQUITY';

    const urgentExit =
      exitReason === 'STOP_LOSS' ||
      exitReason === 'TRAILING_STOP' ||
      exitReason === 'SQUAREOFF_1515' ||
      exitReason === 'KILL_SWITCH';

    const fill = await executeLiveUpstoxOrder({
      symbol: pos.symbol,
      instrumentToken: pos.instrumentKey,
      instrumentType: instType,
      exchange: 'NSE',
      side: exitSide,
      qty: pos.qty,
      referencePrice: pos.currentPrice,
      productType: pos.productType,
      urgentExit,
    });

    if (fill.status !== 'COMPLETE') {
      // Self-healing: record rejection & keep position active so next 3s tick retries exit automatically
      this.addRiskAudit({
        symbol: pos.symbol,
        side: exitSide,
        requestedQty: pos.qty,
        approvedQty: 0,
        strategyId: pos.strategyId,
        decision: 'REJECTED',
        rule: 'UPSTOX_EXIT_RETRY',
        reason: `Exit retry queued (${exitReason}): ${fill.message}`,
      });
      return;
    }

    const exitPrice = fill.executedPrice;
    const exitCharges = fill.chargesInr;

    const grossPnlInr = round2(
      (pos.side === 'BUY' ? exitPrice - pos.entryPrice : pos.entryPrice - exitPrice) * pos.qty
    );
    const totalCharges = round2(pos.entryChargesInr + exitCharges);
    const netPnlInr = round2(grossPnlInr - totalCharges);

    this.state.positions.splice(idx, 1);
    this.state.realizedPnlInr = round2(this.state.realizedPnlInr + netPnlInr);
    this.state.dailyPnlInr = round2(this.state.dailyPnlInr + netPnlInr);
    this.state.totalChargesPaidInr = round2(this.state.totalChargesPaidInr + totalCharges);

    if (netPnlInr > 0) {
      this.state.consecutiveLosses = 0;
    } else {
      this.state.consecutiveLosses += 1;
      if (
        this.state.consecutiveLosses >= this.state.guardrails.consecutiveLossCooldownCount &&
        this.state.status === 'RUNNING'
      ) {
        const until = new Date(
          Date.now() + this.state.guardrails.cooldownMinutes * 60_000
        ).toISOString();
        this.state.status = 'COOLDOWN';
        this.state.cooldownUntil = until;
        this.state.statusReason = `Cooldown active after ${this.state.consecutiveLosses} consecutive losses.`;
      }
    }

    this.state.strategies = this.state.strategies.map((s) =>
      s.id === pos.strategyId
        ? {
            ...s,
            tradesCount: s.tradesCount + 1,
            winCount: s.winCount + (netPnlInr > 0 ? 1 : 0),
            netPnlInr: round2(s.netPnlInr + netPnlInr),
          }
        : s
    );

    const closedTrade: TradeRecord = {
      id: `TRD-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      symbol: pos.symbol,
      instrumentType: instType,
      sector: pos.sector,
      side: pos.side,
      qty: pos.qty,
      entryPrice: pos.entryPrice,
      exitPrice,
      strategyId: pos.strategyId,
      productType: pos.productType,
      grossPnlInr,
      chargesInr: totalCharges,
      netPnlInr,
      exitReason,
      openedAt: pos.openedAt,
      closedAt: new Date().toISOString(),
    };
    this.state.trades.unshift(closedTrade);
    this.appendTradeHistoryLog(closedTrade);
    if (this.state.trades.length > 100) this.state.trades.pop();
    this.adaptStrategyFromClosedTrade(pos.strategyId);
    this.recentOrderTimestamps.push(Date.now());
    void sendTelegramAlert(
      `TRADE CLOSED: ${pos.symbol} (${exitReason})\nQty: ${pos.qty} | Entry ₹${pos.entryPrice.toFixed(2)} -> Exit ₹${exitPrice.toFixed(2)}\nNet PnL: ${netPnlInr >= 0 ? '+' : ''}₹${netPnlInr.toFixed(2)} (Upstox Fees: ₹${totalCharges.toFixed(2)})`
    );
  }

  public async flattenAllPositions(reason: TradeRecord['exitReason']): Promise<void> {
    const ids = this.state.positions.map((p) => p.id);
    for (const id of ids) {
      await this.closePosition(id, reason);
    }
  }

  private addRiskAudit(entry: Omit<RiskAuditEntry, 'id' | 'timestamp'>): void {
    this.state.riskAudit.unshift({
      id: `AUD-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      timestamp: new Date().toISOString(),
      ...entry,
    });
    if (this.state.riskAudit.length > 120) this.state.riskAudit.pop();
  }

  public getSystemHealth() {
    const mem = process.memoryUsage();
    const cpuCount = Math.max(1, os.cpus().length);
    const load1m = os.loadavg()[0] ?? 0;
    const cpuLoadPct = round2(Math.min(100, (load1m / cpuCount) * 100));
    return {
      ok: true,
      status: this.state.status,
      upstoxConnected: Boolean(getUpstoxAccessToken()) && !this.state.upstoxAccountError,
      rssMb: Math.round(mem.rss / 1024 / 1024),
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
      systemTotalMb: Math.round(os.totalmem() / 1024 / 1024),
      systemFreeMb: Math.round(os.freemem() / 1024 / 1024),
      cpuCount,
      loadAvg1m: round2(load1m),
      cpuLoadPct,
      uptimeSec: Math.round(process.uptime()),
    };
  }

  private async handleTelegramCommand(cmd: string, argsText: string): Promise<string> {
    if (cmd === '/balance') {
      await this.syncUpstoxAccountAndQuotes();
    }
    const snap = this.getSnapshot();
    const health = this.getSystemHealth();

    if (cmd === '/health') {
      return [
        `SERVER HEALTH [${snap.status}]`,
        `Process RAM: ${health.rssMb} MB RSS (${health.heapUsedMb} MB heap)`,
        `Host RAM Free: ${health.systemFreeMb} / ${health.systemTotalMb} MB`,
        `CPU Load: ${health.cpuLoadPct}% (1m avg ${health.loadAvg1m} / ${health.cpuCount} vCPU)`,
        `Uptime: ${Math.floor(health.uptimeSec / 60)}m`,
      ].join('\n');
    }

    if (cmd === '/status' || cmd === '/balance' || cmd === '/start') {
      const balStr =
        snap.upstoxLiveBalanceInr !== null
          ? `₹${snap.upstoxLiveBalanceInr.toLocaleString('en-IN')}`
          : snap.upstoxConnected
            ? 'Funds Window Closed (00:00–05:30 IST)'
            : 'Token Expired (send /login or /prompt)';
      const posLine =
        snap.positions.length > 0
          ? snap.positions
              .map(
                (p) =>
                  `${p.symbol} ${p.qty}qty | Entry ₹${p.entryPrice.toFixed(1)} -> LTP ₹${p.currentPrice.toFixed(1)} | MTM ${p.unrealizedPnlInr >= 0 ? '+' : ''}₹${p.unrealizedPnlInr.toFixed(2)}`
              )
              .join('\n')
          : 'None';
      return [
        `ARTHA QUANT [${snap.status}]`,
        `Upstox Live Balance: ${balStr}`,
        `Peak Equity: ₹${snap.peakEquityInr.toLocaleString('en-IN')} | Floor: ₹${snap.survivalFloorInr}`,
        `Daily Net PnL: ${snap.dailyPnlInr >= 0 ? '+' : ''}₹${snap.dailyPnlInr.toFixed(2)} (Fees ₹${snap.totalChargesPaidInr.toFixed(2)})`,
        `NIFTY 50: ${snap.session.nifty50 || '-'} | India VIX: ${snap.session.indiaVix.toFixed(1)} | ${snap.session.phase}`,
        `News Macro: ${snap.newsDigest?.macroSentiment || 'NEUTRAL'} (${snap.newsDigest?.headlines.length ?? 0} headlines)`,
        `Open Slot (${snap.positions.length}/${snap.guardrails.maxOpenPositions}): ${posLine}`,
        `AWS Server: ${health.rssMb} MB RSS | CPU ${health.cpuLoadPct}%`,
      ].join('\n');
    }

    if (cmd === '/login') {
      const clientId = process.env.UPSTOX_API_KEY?.trim() || '';
      const redirectUri =
        process.env.UPSTOX_REDIRECT_URI?.trim() ||
        (process.env.APP_URL
          ? `${process.env.APP_URL.replace(/\/$/, '')}/api/upstox/callback`
          : '');
      if (!clientId || !redirectUri) {
        return 'UPSTOX_API_KEY or UPSTOX_REDIRECT_URI is not set on server.';
      }
      const loginUrl = `https://api.upstox.com/v2/login/authorization/dialog?response_type=code&client_id=${encodeURIComponent(
        clientId
      )}&redirect_uri=${encodeURIComponent(redirectUri)}`;
      return [
        'Tap this link on your phone to log into Upstox:',
        loginUrl,
        '',
        'If your redirect lands directly on the server, it auto-connects. Otherwise copy the redirected URL (with ?code=...) and send:',
        '/code <paste_url_or_code>',
      ].join('\n');
    }

    if (cmd === '/prompt') {
      const res = await requestUpstoxAccessTokenViaNotifier();
      return res.ok
        ? `WhatsApp/Upstox approval prompt sent: ${res.message}`
        : `Failed to send WhatsApp prompt: ${res.error}`;
    }

    if (cmd === '/code') {
      if (!argsText) {
        return 'Usage: /code <auth_code_or_redirected_url>';
      }
      let code = argsText.trim();
      try {
        if (code.includes('code=')) {
          const parsedUrl = new URL(code.startsWith('http') ? code : `https://dummy.local/?${code}`);
          code = parsedUrl.searchParams.get('code') || code;
        }
      } catch {
        const match = code.match(/[?&]code=([^&\s]+)/);
        if (match) code = decodeURIComponent(match[1]);
      }
      const ex = await exchangeUpstoxAuthCode(code);
      if (!ex.ok) {
        return `Upstox code exchange failed: ${ex.error}`;
      }
      this.markTokenApprovedToday();
      await this.syncUpstoxAccountAndQuotes();
      this.resumeAutonomous();
      const after = this.getSnapshot();
      return `TOKEN CONNECTED!\nLive Balance: ${
        after.upstoxLiveBalanceInr !== null
          ? `₹${after.upstoxLiveBalanceInr.toLocaleString('en-IN')}`
          : 'Synced'
      }\nStatus: ${after.status}`;
    }

    if (cmd === '/token') {
      const cleanToken = argsText.replace(/^Bearer\s+/i, '').trim();
      if (!cleanToken) {
        return 'Usage: /token <upstox_access_token>';
      }
      saveUpstoxAccessToken(cleanToken);
      this.markTokenApprovedToday();
      const sync = await this.syncUpstoxAccountAndQuotes();
      if (!sync.ok) {
        return `Token saved, verify warning: ${sync.error}`;
      }
      this.resumeAutonomous();
      const after = this.getSnapshot();
      return `TOKEN ACTIVE!\nLive Balance: ${
        after.upstoxLiveBalanceInr !== null
          ? `₹${after.upstoxLiveBalanceInr.toLocaleString('en-IN')}`
          : 'Synced'
      }\nStatus: ${after.status}`;
    }

    if (cmd === '/pause') {
      this.pauseAutonomous();
      return 'Autonomous trading PAUSED via mobile command. Existing positions remain monitored.';
    }
    if (cmd === '/resume') {
      this.resumeAutonomous();
      return `Autonomous trading RESUMED (${this.state.status}).`;
    }
    if (cmd === '/kill') {
      await this.killSwitch('Emergency Kill-Switch activated from mobile command.');
      return 'EMERGENCY KILL-SWITCH EXECUTED. All live positions flattened & engine halted.';
    }

    return [
      'Artha Quant Phone Commands:',
      '/status - Live balance, equity, Nifty, VIX & position',
      '/balance - Force instant Upstox ₹ balance sync',
      '/login - Get 1-tap Upstox login link for phone',
      '/code <url_or_code> - Exchange Upstox redirect code',
      '/prompt - Send WhatsApp 1-tap Upstox approval prompt',
      '/pause | /resume | /kill - Bot controls',
    ].join('\n');
  }

  public async autonomousTick(): Promise<void> {
    if (this.isStepping) {
      if (Date.now() - this.lastStepStartedAtMs < 25_000) {
        return;
      }
      console.warn('[ArthaQuant Self-Heal] Resetting stalled tick watchdog (>25s).');
    }
    this.isStepping = true;
    this.lastStepStartedAtMs = Date.now();

    try {
      this.state.tickCount += 1;
      this.state.lastTickAt = new Date().toISOString();

      const session = getIstMarketSession(
        this.state.guardrails.autoSquareoffIst,
        this.state.nifty50,
        0,
        this.state.indiaVix,
        this.state.guardrails.vixThrottleThreshold
      );

      // Self-healing daily rollover on new IST trading day (never overrides DEADMAN_LOCK)
      if (this.state.lastSessionIstDate && this.state.lastSessionIstDate !== session.istDateStr) {
        this.state.dailyPnlInr = 0;
        this.state.consecutiveLosses = 0;
        this.state.cooldownUntil = null;
        if (this.state.status === 'HALTED_DAILY_LOSS' || this.state.status === 'COOLDOWN') {
          this.state.status = getUpstoxAccessToken()
            ? 'AWAITING_MARKET_OPEN'
            : 'AWAITING_UPSTOX_TOKEN';
          this.state.statusReason = 'New IST trading session rollover completed automatically.';
        }
      }
      this.state.lastSessionIstDate = session.istDateStr;
      this.recentOrderTimestamps = this.recentOrderTimestamps.filter(
        (ts) => Date.now() - ts < 120_000
      );
      const memRssMb = process.memoryUsage().rss / 1024 / 1024;
      if (memRssMb > 360 && this.state.tickCount % 20 === 0) {
        console.warn(`[ArthaQuant] High RAM warning: ${Math.round(memRssMb)} MB RSS`);
      }

      if (this.state.tickCount % 3 === 1) {
        void pollTelegramCommands((cmd, argsText) => this.handleTelegramCommand(cmd, argsText));
      }
      if (this.state.tickCount % 20 === 1) {
        void refreshMarketNewsDigest();
      }

      if (
        this.state.status === 'DEADMAN_LOCK' ||
        this.state.status === 'HALTED_DAILY_LOSS' ||
        (this.state.status === 'PAUSED' && this.state.positions.length === 0)
      ) {
        return;
      }

      if (!getUpstoxAccessToken()) {
        const prevStatus = this.state.status;
        this.state.status = 'AWAITING_UPSTOX_TOKEN';
        this.state.statusReason =
          'Waiting for daily Upstox token. Scheduled 04:00–05:00 IST WhatsApp approval active (zero repeat spam after approval).';
        this.maybeSendScheduledTokenPrompt();
        if (prevStatus !== this.state.status || this.state.tickCount % 20 === 0) {
          this.persistState();
        }
        return;
      }

      if (this.state.status === 'AWAITING_UPSTOX_TOKEN') {
        this.maybeSendScheduledTokenPrompt();
      }

      // If market is closed (weekend, holiday, pre-open, post-close): sync every 15s so UPI deposits reflect quickly
      if (!session.canExecuteOrders && session.phase !== 'SQUAREOFF_WINDOW') {
        if (this.state.upstoxLiveBalanceInr === null || this.state.tickCount % 5 === 1) {
          await this.warmUpUniverseIfNeeded(session.istDateStr);
          const syncRes = await this.syncUpstoxAccountAndQuotes();
          if (!syncRes.ok && this.state.status === 'AWAITING_UPSTOX_TOKEN') {
            return;
          }
        }
        const prevStatus = this.state.status;
        if (this.state.status !== 'PAUSED') {
          this.state.status = 'AWAITING_MARKET_OPEN';
          this.state.statusReason = session.isHoliday
            ? `NSE Holiday (${session.holidayName}). Live trading resumes next NSE trading day at 09:15 IST.`
            : session.isWeekend
              ? 'Weekend market closure (Sat/Sun). Live trading resumes Monday 09:15 IST.'
              : `Market ${session.phase}. Live Upstox orders armed for 09:15–${this.state.guardrails.autoSquareoffIst} IST.`;
        }
        if (prevStatus !== this.state.status || this.state.tickCount % 20 === 0) {
          this.persistState();
        }
        return;
      }

      // Pull live quotes & warm up daily/intraday candle history during active NSE market hours
      await this.warmUpUniverseIfNeeded(session.istDateStr);
      await this.syncUpstoxAccountAndQuotes();

      if (this.state.status === 'PAUSED') {
        // Keep entries paused while still monitoring stops/targets/15:05 squareoff below
      } else if (session.phase === 'SQUAREOFF_WINDOW') {
        this.state.status = 'SQUAREOFF_WINDOW';
        this.state.statusReason = `${this.state.guardrails.autoSquareoffIst} IST MIS auto-squareoff window active (exiting before broker RMS cutoff).`;
      } else if (
        this.state.status === 'COOLDOWN' &&
        this.state.cooldownUntil &&
        Date.now() >= new Date(this.state.cooldownUntil).getTime()
      ) {
        this.state.status = 'RUNNING';
        this.state.cooldownUntil = null;
        this.state.consecutiveLosses = 0;
        this.state.statusReason = 'Cooldown elapsed; autonomous Upstox execution active.';
      } else if (
        this.state.status === 'AWAITING_UPSTOX_TOKEN' ||
        this.state.status === 'AWAITING_MARKET_OPEN' ||
        this.state.status === 'SQUAREOFF_WINDOW'
      ) {
        this.state.status = 'RUNNING';
        this.state.statusReason = 'Live NSE session active — autonomous Upstox execution running.';
      }

      // Automatically run Quant Regime Supervisor every 60s (built-in deterministic engine needs zero API keys; optional Gemini upgrade if key present)
      if (
        this.state.status === 'RUNNING' &&
        Date.now() - this.lastAiRunMs >= 60_000
      ) {
        try {
          await this.triggerAiSupervisor();
        } catch {
          // Non-fatal; 11-gate risk firewall still guards capital
        }
      }

      const safeToTrade = await this.manageOpenPositionsAndBreakers(
        session.phase === 'SQUAREOFF_WINDOW'
      );

      if (safeToTrade && this.state.status === 'RUNNING') {
        await this.evaluateNewEntries(session.canExecuteOrders, session.indiaVix);
      }

      if (this.state.tickCount % 10 === 0 || this.state.equityCurve.length <= 1) {
        const eq = this.computeEquityMetrics();
        const ddNow =
          this.state.peakEquityInr > 0
            ? round2(
                ((this.state.peakEquityInr - eq.currentEquity) / this.state.peakEquityInr) * 100
              )
            : 0;
        this.state.equityCurve.push({
          timestamp: this.state.lastTickAt,
          label: session.istTimeStr.slice(0, 5),
          equityInr: eq.currentEquity,
          drawdownPct: ddNow,
          survivalFloorInr: eq.survivalFloor,
        });
        if (this.state.equityCurve.length > 160) {
          this.state.equityCurve.shift();
        }
      }

      this.persistState();
    } catch (err) {
      // Self-healing: record transient runtime error and keep the autonomous 3s daemon alive
      this.state.upstoxAccountError =
        err instanceof Error ? err.message : 'Transient engine tick error recovered.';
      this.persistState();
    } finally {
      this.isStepping = false;
    }
  }

  private async evaluateNewEntries(
    canExecuteOrders: boolean,
    indiaVix: number
  ): Promise<void> {
    if (this.state.positions.length >= this.state.guardrails.maxOpenPositions) {
      return;
    }
    // Block new intraday entries within 10 mins of autoSquareoffIst (14:55 IST cutoff before 15:05 squareoff)
    const istParts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date());
    const hh = Number(istParts.find((p) => p.type === 'hour')?.value || '0');
    const mm = Number(istParts.find((p) => p.type === 'minute')?.value || '0');
    const nowMins = hh * 60 + mm;
    const [sqH, sqM] = this.state.guardrails.autoSquareoffIst.split(':').map(Number);
    const sqMins = (Number.isFinite(sqH) ? sqH : 15) * 60 + (Number.isFinite(sqM) ? sqM : 5);
    // Avoid first 5 minutes opening-bell volatility spikes (09:15–09:19 IST) and final 10 minutes before squareoff
    if (canExecuteOrders && (nowMins < 9 * 60 + 20 || nowMins >= sqMins - 10)) {
      return;
    }

    const eq = this.computeEquityMetrics();
    const aiScalar = this.state.aiAutoApply ? this.state.aiThrottleMultiplier : 1.0;
    const niftyChg =
      this.state.niftyBase > 0
        ? ((this.state.nifty50 - this.state.niftyBase) / this.state.niftyBase) * 100
        : 0;

    // 1. Check NIFTY 50 Index Option Buying (BUY CE when bullish, BUY PE when bearish — NEVER Option Writing)
    if (this.state.guardrails.allowIndexOptions !== false) {
      const bearishBreadth = this.state.tickers.filter(
        (t) => t.ltp > 0 && t.ltp < t.vwap && t.ema9 < t.ema21
      ).length;
      const bullishBreadth = this.state.tickers.filter(
        (t) => t.ltp > 0 && t.ltp > t.vwap && t.ema9 > t.ema21
      ).length;

      let optionBias: 'CE' | 'PE' | null = null;
      if (niftyChg <= -0.45 && bearishBreadth >= 5) {
        optionBias = 'PE';
      } else if (niftyChg >= 0.45 && bullishBreadth >= 5) {
        optionBias = 'CE';
      }

      if (optionBias) {
        const maxBudget = eq.currentEquity * (this.state.guardrails.maxSingleStockWeightPct / 100);
        const optRes = await fetchAffordableNiftyOption(optionBias, maxBudget);
        if (optRes.ok && optRes.option) {
          const opt = optRes.option;
          const stopDistance = round2(Math.max(opt.ltp * 0.18, 5));
          const targetDistance = round2(stopDistance * 2.0);
          const stopLoss = round2(Math.max(1, opt.ltp - stopDistance));
          const takeProfit = round2(opt.ltp + targetDistance);
          const instType: InstrumentType = optionBias === 'CE' ? 'OPTION_CE' : 'OPTION_PE';
          const optConfidence = Math.min(
            94,
            Math.round(
              76 +
                (Math.abs(niftyChg) >= 0.65 ? 8 : 0) +
                (optionBias === 'CE' && bullishBreadth >= 7 ? 6 : 0) +
                (optionBias === 'PE' && bearishBreadth >= 7 ? 6 : 0)
            )
          );
          const optConvictionBudget =
            eq.availableMargin *
            (optConfidence >= 82 ? 1.0 : Math.min(0.9, 0.45 + (optConfidence - 65) * 0.02)) *
            aiScalar;
          const requestedLots = Math.max(
            1,
            Math.floor(optConvictionBudget / Math.max(1, opt.ltp * opt.lotSize))
          );
          const optRequestedQty = requestedLots * opt.lotSize;

          const optTicker: MarketTickerSnapshot = {
            symbol: opt.tradingSymbol,
            name: opt.tradingSymbol,
            sector: 'Banking',
            instrumentKey: opt.instrumentKey,
            ltp: opt.ltp,
            open: opt.ltp,
            high: opt.ltp,
            low: opt.ltp,
            prevClose: opt.ltp,
            changePct: niftyChg,
            vwap: opt.ltp,
            atr14: stopDistance,
            rsi14: 50,
            zScore: 0,
            rvol: 1.5,
            ema9: opt.ltp,
            ema21: opt.ltp,
            signal: 'ORB_VWAP',
            signalSide: 'BUY',
            signalConfidence: optConfidence,
            lastQuoteAt: new Date().toISOString(),
          };

          const riskResult = evaluatePreTradeRisk({
            engineStatus: this.state.status,
            guardrails: this.state.guardrails,
            ticker: optTicker,
            instrumentType: instType,
            lotSize: opt.lotSize,
            side: 'BUY',
            requestedQty: optRequestedQty,
            stopLossPrice: stopLoss,
            takeProfitPrice: takeProfit,
            strategyId: 'ORB_VWAP',
            currentEquityInr: eq.currentEquity,
            peakEquityInr: this.state.peakEquityInr,
            availableMarginInr: eq.availableMargin,
            dailyPnlInr: this.state.dailyPnlInr + eq.unrealizedPnl,
            openPositions: this.state.positions,
            recentOrderTimestamps: this.recentOrderTimestamps,
            indiaVix,
            canExecuteOrders,
            signalConfidence: optConfidence,
            tradedTodaySymbols: this.getTodayTradedSymbols(),
          });

          this.addRiskAudit({
            symbol: opt.tradingSymbol,
            side: 'BUY',
            requestedQty: optRequestedQty,
            approvedQty: riskResult.approvedQty,
            strategyId: 'ORB_VWAP',
            decision: riskResult.decision,
            rule: riskResult.rule,
            reason: riskResult.reason,
          });

          if (riskResult.approved && riskResult.approvedQty >= opt.lotSize) {
            const fill = await executeLiveUpstoxOrder({
              symbol: opt.tradingSymbol,
              instrumentToken: opt.instrumentKey,
              instrumentType: instType,
              exchange: 'NSE',
              side: 'BUY',
              qty: riskResult.approvedQty,
              referencePrice: opt.ltp,
              productType: this.state.guardrails.productType,
            });

            if (fill.status === 'COMPLETE') {
              this.recentOrderTimestamps.push(Date.now());
              this.state.positions.push({
                id: fill.orderId,
                symbol: opt.tradingSymbol,
                instrumentKey: opt.instrumentKey,
                instrumentType: instType,
                lotSize: opt.lotSize,
                sector: 'Banking',
                side: 'BUY',
                qty: fill.qty,
                entryPrice: fill.executedPrice,
                currentPrice: fill.executedPrice,
                stopLoss,
                trailingStop: null,
                takeProfit,
                strategyId: 'ORB_VWAP',
                productType: this.state.guardrails.productType,
                entryChargesInr: fill.chargesInr,
                unrealizedPnlInr: round2(-fill.chargesInr),
                riskAmountInr: round2(Math.abs(fill.executedPrice - stopLoss) * fill.qty),
                openedAt: new Date().toISOString(),
              });
              void sendTelegramAlert(
                `BUY FILLED (${instType}): ${fill.qty} ${opt.tradingSymbol} @ ₹${fill.executedPrice.toFixed(2)} | SL ₹${stopLoss.toFixed(1)} | Target ₹${takeProfit.toFixed(1)}`
              );
              return;
            }
          }
        }
      }
    }

    // 2. Otherwise evaluate Long-Only Equity BUY signals across up to maxOpenPositions slots (never duplicate same symbol same day)
    const candidates = this.state.tickers
      .filter((t) => t.ltp > 0 && t.signal !== null && t.signalSide === 'BUY')
      .sort((a, b) => b.signalConfidence - a.signalConfidence);

    if (candidates.length === 0) return;

    for (const top of candidates.slice(0, 6)) {
      if (this.state.positions.length >= this.state.guardrails.maxOpenPositions) {
        break;
      }
      const liveEq = this.computeEquityMetrics();
      if (liveEq.availableMargin < top.ltp) {
        continue;
      }

      const strat = this.state.strategies.find((s) => s.id === top.signal);
      if (!strat || !strat.enabled || top.signalConfidence < strat.minConfidence) {
        continue;
      }

      if (niftyChg <= -0.85 && strat.id !== 'MEAN_REVERSION') {
        this.addRiskAudit({
          symbol: top.symbol,
          side: 'BUY',
          requestedQty: 0,
          approvedQty: 0,
          strategyId: strat.id,
          decision: 'THROTTLED',
          rule: 'NIFTY_SELLOFF_GUARD',
          reason: `Blocked LONG ${top.symbol} (${strat.id}) because NIFTY 50 is down ${niftyChg.toFixed(2)}%.`,
        });
        continue;
      }

      if (
        this.state.aiAutoApply &&
        this.state.aiSupervisor &&
        this.state.aiSupervisor.vetoedSymbols.includes(top.symbol)
      ) {
        this.addRiskAudit({
          symbol: top.symbol,
          side: 'BUY',
          requestedQty: 0,
          approvedQty: 0,
          strategyId: strat.id,
          decision: 'THROTTLED',
          rule: 'SUPERVISOR_VETO',
          reason: `Quant Regime Supervisor vetoed ${top.symbol} under ${this.state.aiSupervisor.regimeAssessment} regime.`,
        });
        continue;
      }

      const symNews = getCachedMarketNewsDigest().symbolBias[top.symbol];
      if (symNews && symNews.score <= -2) {
        this.addRiskAudit({
          symbol: top.symbol,
          side: 'BUY',
          requestedQty: 0,
          approvedQty: 0,
          strategyId: strat.id,
          decision: 'THROTTLED',
          rule: 'NEWS_BEARISH_VETO',
          reason: `Bearish headline vetoed LONG ${top.symbol}: "${symNews.headline}"`,
        });
        continue;
      }

      const side: OrderSide = 'BUY';
      const stopDistance = Math.max(top.atr14 * strat.stopLossAtrMult, top.ltp * 0.005);
      const targetDistance = Math.max(top.atr14 * strat.targetAtrMult, stopDistance * 1.8);

      const stopLoss = round2(top.ltp - stopDistance);
      const takeProfit = round2(top.ltp + targetDistance);

      const pctRiskInr = liveEq.currentEquity * (this.state.guardrails.riskPerTradePct / 100);
      const clampedRiskInr =
        liveEq.currentEquity >= 4000
          ? Math.min(2000, Math.max(1000, pctRiskInr))
          : Math.max(250, pctRiskInr);
      const rawTargetRiskInr = clampedRiskInr * (strat.capitalWeightPct / 35) * aiScalar;
      const riskBasedQty = Math.max(1, Math.floor(rawTargetRiskInr / stopDistance));

      // Conviction scaling (1.0x zero-margin cash only): high-confidence signals deploy up to maxSingleStockWeightPct of available cash
      let requestedQty = riskBasedQty;
      if (top.signalConfidence >= 80 && indiaVix < this.state.guardrails.vixThrottleThreshold) {
        const cashShare = Math.min(1.0, 0.55 + ((top.signalConfidence - 80) / 15) * 0.45) * aiScalar;
        const convictionQty = Math.floor((liveEq.availableMargin * cashShare) / top.ltp);
        requestedQty = Math.max(riskBasedQty, convictionQty);
      }

      const riskResult = evaluatePreTradeRisk({
        engineStatus: this.state.status,
        guardrails: this.state.guardrails,
        ticker: top,
        instrumentType: 'EQUITY',
        side,
        requestedQty,
        stopLossPrice: stopLoss,
        takeProfitPrice: takeProfit,
        strategyId: strat.id,
        currentEquityInr: liveEq.currentEquity,
        peakEquityInr: this.state.peakEquityInr,
        availableMarginInr: liveEq.availableMargin,
        dailyPnlInr: this.state.dailyPnlInr + liveEq.unrealizedPnl,
        openPositions: this.state.positions,
        recentOrderTimestamps: this.recentOrderTimestamps,
        indiaVix,
        canExecuteOrders,
        signalConfidence: top.signalConfidence,
        tradedTodaySymbols: this.getTodayTradedSymbols(),
      });

      this.addRiskAudit({
        symbol: top.symbol,
        side,
        requestedQty,
        approvedQty: riskResult.approvedQty,
        strategyId: strat.id,
        decision: riskResult.decision,
        rule: riskResult.rule,
        reason: riskResult.reason,
      });

      if (!riskResult.approved || riskResult.approvedQty < 1) {
        continue;
      }

      const fill = await executeLiveUpstoxOrder({
        symbol: top.symbol,
        instrumentType: 'EQUITY',
        exchange: 'NSE',
        side,
        qty: riskResult.approvedQty,
        referencePrice: top.ltp,
        productType: this.state.guardrails.productType,
      });

      if (fill.status !== 'COMPLETE') {
        this.addRiskAudit({
          symbol: top.symbol,
          side,
          requestedQty: riskResult.approvedQty,
          approvedQty: 0,
          strategyId: strat.id,
          decision: 'REJECTED',
          rule: 'UPSTOX_EXECUTION_REJECTED',
          reason: fill.message,
        });
        continue;
      }

      this.recentOrderTimestamps.push(Date.now());
      this.state.positions.push({
        id: fill.orderId,
        symbol: top.symbol,
        instrumentKey: top.instrumentKey,
        instrumentType: 'EQUITY',
        sector: top.sector,
        side,
        qty: fill.qty,
        entryPrice: fill.executedPrice,
        currentPrice: fill.executedPrice,
        stopLoss,
        trailingStop: null,
        takeProfit,
        strategyId: strat.id,
        productType: this.state.guardrails.productType,
        entryChargesInr: fill.chargesInr,
        unrealizedPnlInr: round2(-fill.chargesInr),
        riskAmountInr: round2(Math.abs(fill.executedPrice - stopLoss) * fill.qty),
        openedAt: new Date().toISOString(),
      });
      void sendTelegramAlert(
        `BUY ORDER FILLED (${strat.id})\n${top.symbol} x ${fill.qty} @ ₹${fill.executedPrice.toFixed(2)}\nStop Loss: ₹${stopLoss.toFixed(1)} | Target: ₹${takeProfit.toFixed(1)}\nEntry Fees: ₹${fill.chargesInr.toFixed(2)}`
      );
    }
  }
}
