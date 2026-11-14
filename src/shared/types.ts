export type BrokerId = 'upstox';

export type EngineStatus =
  | 'AWAITING_UPSTOX_TOKEN'
  | 'AWAITING_MARKET_OPEN'
  | 'RUNNING'
  | 'COOLDOWN'
  | 'HALTED_DAILY_LOSS'
  | 'DEADMAN_LOCK'
  | 'SQUAREOFF_WINDOW'
  | 'PAUSED';

export type StrategyId = 'ORB_VWAP' | 'MEAN_REVERSION' | 'PAIRS_SPREAD';

export type MarketRegime = 'TRENDING_UP' | 'RANGE_BOUND' | 'HIGH_VOLATILITY' | 'DEFENSIVE';

export type ProductType = 'MIS' | 'CNC';

export type OrderSide = 'BUY' | 'SELL';

export type InstrumentType = 'EQUITY' | 'OPTION_CE' | 'OPTION_PE';

export type SectorName =
  | 'Banking'
  | 'IT'
  | 'Energy'
  | 'Telecom'
  | 'Auto'
  | 'Pharma'
  | 'FMCG'
  | 'CapitalGoods';

export interface GuardrailsConfig {
  allocatedCapitalInr: number;
  maxDailyLossPct: number;
  maxTotalDrawdownPct: number;
  riskPerTradePct: number;
  maxOpenPositions: number;
  maxSingleStockWeightPct: number;
  maxSectorPositions: number;
  maxOrdersPerMinute: number;
  consecutiveLossCooldownCount: number;
  cooldownMinutes: number;
  vixThrottleThreshold: number;
  autoSquareoffIst: string;
  slippageBps: number;
  productType: ProductType;
  allowIndexOptions?: boolean;
}

export interface StrategyConfig {
  id: StrategyId;
  name: string;
  description: string;
  enabled: boolean;
  capitalWeightPct: number;
  minConfidence: number;
  stopLossAtrMult: number;
  targetAtrMult: number;
  tradesCount: number;
  winCount: number;
  netPnlInr: number;
}

export interface IndianCostBreakdown {
  turnoverInr: number;
  brokerageInr: number;
  sttInr: number;
  exchangeTxnInr: number;
  sebiFeeInr: number;
  stampDutyInr: number;
  ipftInr: number;
  gstInr: number;
  totalChargesInr: number;
}

export interface MarketTickerSnapshot {
  symbol: string;
  name: string;
  sector: SectorName;
  instrumentKey: string;
  ltp: number;
  open: number;
  high: number;
  low: number;
  prevClose: number;
  changePct: number;
  vwap: number;
  atr14: number;
  rsi14: number;
  zScore: number;
  rvol: number;
  ema9: number;
  ema21: number;
  signal: StrategyId | null;
  signalSide: OrderSide | null;
  signalConfidence: number;
  lastQuoteAt: string | null;
}

export interface Position {
  id: string;
  symbol: string;
  instrumentKey?: string;
  instrumentType?: InstrumentType;
  lotSize?: number;
  sector: SectorName;
  side: OrderSide;
  qty: number;
  entryPrice: number;
  currentPrice: number;
  stopLoss: number;
  trailingStop: number | null;
  takeProfit: number;
  strategyId: StrategyId;
  productType: ProductType;
  entryChargesInr: number;
  unrealizedPnlInr: number;
  riskAmountInr: number;
  openedAt: string;
}

export interface TradeRecord {
  id: string;
  symbol: string;
  instrumentType?: InstrumentType;
  sector: SectorName;
  side: OrderSide;
  qty: number;
  entryPrice: number;
  exitPrice: number;
  strategyId: StrategyId;
  productType: ProductType;
  grossPnlInr: number;
  chargesInr: number;
  netPnlInr: number;
  exitReason:
    | 'TAKE_PROFIT'
    | 'STOP_LOSS'
    | 'TRAILING_STOP'
    | 'SQUAREOFF_1515'
    | 'KILL_SWITCH'
    | 'SIGNAL_EXIT';
  openedAt: string;
  closedAt: string;
}

export interface RiskAuditEntry {
  id: string;
  timestamp: string;
  symbol: string;
  side: OrderSide;
  requestedQty: number;
  approvedQty: number;
  strategyId: StrategyId;
  decision: 'APPROVED' | 'REJECTED' | 'THROTTLED' | 'CIRCUIT_BREAKER';
  rule: string;
  reason: string;
}

export interface EquityPoint {
  timestamp: string;
  label: string;
  equityInr: number;
  drawdownPct: number;
  survivalFloorInr: number;
}

export interface BrokerStatusInfo {
  id: BrokerId;
  label: string;
  configured: boolean;
  mode: 'live';
  missingEnvVars: string[];
  notes: string;
}

export interface NseHolidayItem {
  date: string;
  description: string;
}

export interface MarketSessionInfo {
  istTimeStr: string;
  istDateStr: string;
  phase: 'PRE_OPEN' | 'LIVE_TRADING' | 'SQUAREOFF_WINDOW' | 'POST_CLOSE' | 'HOLIDAY' | 'CLOSED';
  isWeekend: boolean;
  isHoliday: boolean;
  holidayName: string | null;
  calendarSource: 'nseindia.com' | 'verified-2026-nse-schedule';
  nextHolidays: NseHolidayItem[];
  canExecuteOrders: boolean;
  nifty50: number;
  niftyChangePct: number;
  indiaVix: number;
  regime: MarketRegime;
}

export interface AiSupervisorReport {
  timestamp: string;
  model: string;
  regimeAssessment: 'RISK_ON' | 'SELECTIVE' | 'DEFENSIVE' | 'STAND_DOWN';
  recommendedThrottle: number;
  convictionScore: number;
  approvedSymbols: string[];
  vetoedSymbols: string[];
  recommendedActions: string[];
  deskSummary: string;
  taxDragAssessment: string;
  autoApplyEnabled: boolean;
}

export interface StaticIpInfo {
  serverOutboundIp: string | null;
  checkedAt: string | null;
  sebiWhitelistReady: boolean;
  webhookEndpoint: string;
  notes: string;
}

export interface BotStateSnapshot {
  status: EngineStatus;
  activeBroker: BrokerId;
  tradingMode: 'live';
  upstoxConnected: boolean;
  upstoxOAuthConfigured: boolean;
  upstoxLiveBalanceInr: number | null;
  upstoxLastSyncAt: string | null;
  upstoxAccountError: string | null;
  statusReason: string;
  cooldownUntil: string | null;
  tickCount: number;
  lastTickAt: string;
  initialCapitalInr: number;
  peakEquityInr: number;
  currentEquityInr: number;
  availableMarginInr: number;
  usedMarginInr: number;
  survivalFloorInr: number;
  survivalBufferInr: number;
  survivalBufferPct: number;
  dailyPnlInr: number;
  dailyPnlPct: number;
  totalRealizedPnlInr: number;
  totalUnrealizedPnlInr: number;
  totalChargesPaidInr: number;
  consecutiveLosses: number;
  winRatePct: number;
  profitFactor: number;
  maxDrawdownSeenPct: number;
  guardrails: GuardrailsConfig;
  strategies: StrategyConfig[];
  session: MarketSessionInfo;
  tickers: MarketTickerSnapshot[];
  positions: Position[];
  trades: TradeRecord[];
  riskAudit: RiskAuditEntry[];
  equityCurve: EquityPoint[];
  brokers: BrokerStatusInfo[];
  aiSupervisor: AiSupervisorReport | null;
  aiThrottleMultiplier: number;
  staticIp: StaticIpInfo;
}

export interface BacktestRequest {
  days: number;
}

export interface BacktestResult {
  daysSimulated: number;
  dataSource: 'UPSTOX_V3_HISTORICAL_CANDLES';
  startingCapitalInr: number;
  endingCapitalInr: number;
  netReturnPct: number;
  maxDrawdownPct: number;
  survivalFloorInr: number;
  survived: boolean;
  survivalStatusReason: string;
  sharpeRatio: number;
  profitFactor: number;
  winRatePct: number;
  totalTrades: number;
  rejectedByRiskCount: number;
  totalStatutoryChargesInr: number;
  equityCurve: EquityPoint[];
  strategyBreakdown: Array<{
    strategyId: StrategyId;
    name: string;
    trades: number;
    winRatePct: number;
    netPnlInr: number;
  }>;
}
