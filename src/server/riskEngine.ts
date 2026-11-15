import type {
  EngineStatus,
  GuardrailsConfig,
  InstrumentType,
  MarketTickerSnapshot,
  OrderSide,
  Position,
  StrategyId,
} from '../shared/types.ts';
import { calculateIndianTransactionCosts, round2 } from './indiaMarket.ts';

export interface RiskCheckInput {
  engineStatus: EngineStatus;
  guardrails: GuardrailsConfig;
  ticker: MarketTickerSnapshot;
  instrumentType?: InstrumentType;
  lotSize?: number;
  side: OrderSide;
  requestedQty: number;
  stopLossPrice: number;
  takeProfitPrice?: number;
  strategyId: StrategyId;
  currentEquityInr: number;
  peakEquityInr: number;
  availableMarginInr: number;
  dailyPnlInr: number;
  openPositions: Position[];
  recentOrderTimestamps: number[];
  indiaVix: number;
  canExecuteOrders: boolean;
  signalConfidence?: number;
  tradedTodaySymbols?: string[];
}

export interface RiskCheckResult {
  decision: 'APPROVED' | 'REJECTED' | 'THROTTLED' | 'CIRCUIT_BREAKER';
  approved: boolean;
  approvedQty: number;
  rule: string;
  reason: string;
}

export function computeSurvivalFloor(
  initialOrPeakCapital: number,
  maxTotalDrawdownPct: number,
  _principalCapitalInr?: number
): number {
  if (maxTotalDrawdownPct >= 100 || initialOrPeakCapital <= 0) {
    return 0;
  }
  const trailingFloor = initialOrPeakCapital * (1 - maxTotalDrawdownPct / 100);
  return round2(Math.max(0, trailingFloor));
}

export function evaluatePreTradeRisk(input: RiskCheckInput): RiskCheckResult {
  const {
    engineStatus,
    guardrails,
    ticker,
    side,
    requestedQty,
    stopLossPrice,
    takeProfitPrice,
    currentEquityInr,
    peakEquityInr,
    availableMarginInr,
    dailyPnlInr,
    openPositions,
    recentOrderTimestamps,
    indiaVix,
    canExecuteOrders,
  } = input;

  // 0. Hard Long-Only Gate (NEVER short sell)
  if (side !== 'BUY') {
    return {
      decision: 'REJECTED',
      approved: false,
      approvedQty: 0,
      rule: 'LONG_ONLY_NO_SHORT_SELL',
      reason: 'Short selling is strictly prohibited; engine only executes BUY entries.',
    };
  }

  // 1. Engine lock / circuit-breaker states
  if (engineStatus === 'DEADMAN_LOCK') {
    return {
      decision: 'CIRCUIT_BREAKER',
      approved: false,
      approvedQty: 0,
      rule: 'DEADMAN_SURVIVAL_LOCK',
      reason: 'Max total drawdown floor breached; engine locked until explicit operator reset.',
    };
  }

  if (engineStatus === 'HALTED_DAILY_LOSS') {
    return {
      decision: 'CIRCUIT_BREAKER',
      approved: false,
      approvedQty: 0,
      rule: 'DAILY_LOSS_CIRCUIT_BREAKER',
      reason: 'Daily loss cap reached; new entries blocked for remainder of session.',
    };
  }

  if (engineStatus === 'COOLDOWN') {
    return {
      decision: 'THROTTLED',
      approved: false,
      approvedQty: 0,
      rule: 'CONSECUTIVE_LOSS_COOLDOWN',
      reason: 'Consecutive loss cooldown active; waiting for volatility & signal reset.',
    };
  }

  if (!canExecuteOrders) {
    return {
      decision: 'REJECTED',
      approved: false,
      approvedQty: 0,
      rule: 'MARKET_SESSION_GATE',
      reason: `Outside permitted NSE execution window (or ${guardrails.autoSquareoffIst} IST MIS squareoff window).`,
    };
  }

  // 2. Survival Floor Guard (₹0 floor when maxTotalDrawdownPct = 100)
  const survivalFloor = computeSurvivalFloor(peakEquityInr, guardrails.maxTotalDrawdownPct);
  if (currentEquityInr <= 0 || (survivalFloor > 0 && currentEquityInr <= survivalFloor)) {
    return {
      decision: 'CIRCUIT_BREAKER',
      approved: false,
      approvedQty: 0,
      rule: 'SURVIVAL_FLOOR_BREACH',
      reason: `Equity ₹${currentEquityInr.toFixed(0)} at/below survival floor ₹${survivalFloor.toFixed(0)}.`,
    };
  }

  // 3. Daily Max Loss Guard (bypassed when maxDailyLossPct >= 100 for full comeback allowance)
  const maxDailyLossInr =
    guardrails.maxDailyLossPct >= 100
      ? Number.MAX_SAFE_INTEGER
      : Math.max(100, currentEquityInr * (guardrails.maxDailyLossPct / 100));
  if (guardrails.maxDailyLossPct < 100 && dailyPnlInr <= -maxDailyLossInr) {
    return {
      decision: 'CIRCUIT_BREAKER',
      approved: false,
      approvedQty: 0,
      rule: 'DAILY_MAX_LOSS',
      reason: `Daily PnL ₹${dailyPnlInr.toFixed(0)} hit -${guardrails.maxDailyLossPct}% limit (-₹${maxDailyLossInr.toFixed(0)}).`,
    };
  }

  // 4. Order Rate Limit (sliding 60s window)
  const nowMs = Date.now();
  const ordersLastMinute = recentOrderTimestamps.filter((ts) => nowMs - ts < 60_000).length;
  if (ordersLastMinute >= guardrails.maxOrdersPerMinute) {
    return {
      decision: 'THROTTLED',
      approved: false,
      approvedQty: 0,
      rule: 'ORDER_RATE_LIMIT',
      reason: `Rate limit hit (${ordersLastMinute}/${guardrails.maxOrdersPerMinute} orders in 60s).`,
    };
  }

  // 5. Duplicate symbol check (active OR already bought & closed earlier today)
  if (openPositions.some((p) => p.symbol === ticker.symbol)) {
    return {
      decision: 'REJECTED',
      approved: false,
      approvedQty: 0,
      rule: 'DUPLICATE_SYMBOL_GUARD',
      reason: `Active position already open in ${ticker.symbol}.`,
    };
  }

  if (input.tradedTodaySymbols?.includes(ticker.symbol)) {
    return {
      decision: 'REJECTED',
      approved: false,
      approvedQty: 0,
      rule: 'NO_SAME_DAY_REENTRY',
      reason: `${ticker.symbol} was already traded today; same-day re-entry blocked for clean diversification.`,
    };
  }

  // 6. Max concurrent positions
  if (openPositions.length >= guardrails.maxOpenPositions) {
    return {
      decision: 'REJECTED',
      approved: false,
      approvedQty: 0,
      rule: 'MAX_OPEN_POSITIONS',
      reason: `Portfolio at max ${guardrails.maxOpenPositions} concurrent positions.`,
    };
  }

  // 7. Sector concentration cap
  const sectorCount = openPositions.filter((p) => p.sector === ticker.sector).length;
  if (sectorCount >= guardrails.maxSectorPositions) {
    return {
      decision: 'REJECTED',
      approved: false,
      approvedQty: 0,
      rule: 'SECTOR_CONCENTRATION_CAP',
      reason: `${ticker.sector} already has ${sectorCount}/${guardrails.maxSectorPositions} positions.`,
    };
  }

  // 8. Fat-finger / VWAP deviation collar
  const vwapDeviationPct = Math.abs((ticker.ltp - ticker.vwap) / ticker.vwap) * 100;
  if (vwapDeviationPct > 3.5) {
    return {
      decision: 'REJECTED',
      approved: false,
      approvedQty: 0,
      rule: 'FAT_FINGER_PRICE_COLLAR',
      reason: `LTP deviates ${vwapDeviationPct.toFixed(2)}% from VWAP (>3.5% collar).`,
    };
  }

  // 9. ATR & Volatility-scaled Position Sizing (Life-or-Death Cap)
  const stopDistance = Math.abs(ticker.ltp - stopLossPrice);
  if (stopDistance <= 0.05) {
    return {
      decision: 'REJECTED',
      approved: false,
      approvedQty: 0,
      rule: 'INVALID_STOP_DISTANCE',
      reason: 'Stop-loss distance too narrow; order rejected to avoid noise whipsaw.',
    };
  }

  const instrumentType: InstrumentType = input.instrumentType || 'EQUITY';
  const isOptionBuy = instrumentType === 'OPTION_CE' || instrumentType === 'OPTION_PE';
  const lotSize = Math.max(1, input.lotSize || 1);
  const conviction = input.signalConfidence ?? ticker.signalConfidence ?? 65;

  const vixMultiplier = indiaVix >= guardrails.vixThrottleThreshold ? 0.5 : 1.0;
  // On A+ Equity setups (>=80 confidence, calm VIX), allow 1.25x headroom; enforce ₹1,000–₹2,000 stop-risk envelope when capital supports it
  const convictionRiskBoost =
    !isOptionBuy && conviction >= 80 && indiaVix < guardrails.vixThrottleThreshold ? 1.25 : 1.0;
  const pctRiskInr = currentEquityInr * (guardrails.riskPerTradePct / 100);
  const clampedDollarRiskInr =
    currentEquityInr >= 4000
      ? Math.min(2000, Math.max(1000, pctRiskInr))
      : Math.max(250, pctRiskInr);
  const maxRiskInr = clampedDollarRiskInr * vixMultiplier * convictionRiskBoost;
  const riskCappedQty = Math.floor(maxRiskInr / stopDistance);

  // Single-position cap (defaults to 100% of live equity for high-conviction 1-slot cash deployment)
  const maxStockNotionalInr =
    currentEquityInr * (guardrails.maxSingleStockWeightPct / 100);
  const weightCappedQty = Math.floor(maxStockNotionalInr / ticker.ltp);

  // Zero-margin cash rule: strictly 1.0x available live balance only (never take broker leverage/margin)
  const marginLeverage = 1.0;
  const marginCappedQty = Math.floor((availableMarginInr * marginLeverage) / ticker.ltp);

  let approvedQty = Math.max(
    0,
    Math.min(requestedQty, riskCappedQty, weightCappedQty, marginCappedQty)
  );

  if (isOptionBuy) {
    const lotMaxStopRisk = stopDistance * lotSize;
    const requestedLots = Math.max(1, Math.floor(requestedQty / lotSize));
    const affordableLots = Math.floor(Math.min(weightCappedQty, marginCappedQty) / lotSize);
    const maxLotsByRisk = Math.max(0, Math.floor(maxRiskInr / Math.max(1, lotMaxStopRisk)));
    const maxLotsByDailyLoss =
      guardrails.maxDailyLossPct >= 100
        ? Number.MAX_SAFE_INTEGER
        : Math.max(0, Math.floor(maxDailyLossInr / Math.max(1, lotMaxStopRisk)));
    const lotsApproved = Math.min(requestedLots, affordableLots, maxLotsByRisk, maxLotsByDailyLoss);
    approvedQty = lotsApproved >= 1 ? lotsApproved * lotSize : 0;
  }

  if (approvedQty < lotSize) {
    return {
      decision: 'REJECTED',
      approved: false,
      approvedQty: 0,
      rule: 'TICKET_SIZE_CAPITAL_FIT',
      reason: `${lotSize} unit(s) of ${ticker.symbol} (₹${(ticker.ltp * lotSize).toFixed(0)}) exceeds single-position cap (₹${maxStockNotionalInr.toFixed(0)}) or available margin.`,
    };
  }

  // 10. Indian Brokerage & STT Fee-Drag Expectancy Gate
  const entryCharges = calculateIndianTransactionCosts(
    ticker.ltp,
    approvedQty,
    side,
    guardrails.productType,
    instrumentType
  ).totalChargesInr;
  const exitCharges = calculateIndianTransactionCosts(
    ticker.ltp,
    approvedQty,
    'SELL',
    guardrails.productType,
    instrumentType
  ).totalChargesInr;
  const roundTripFees = round2(entryCharges + exitCharges);
  const targetDistance = takeProfitPrice
    ? Math.abs(takeProfitPrice - ticker.ltp)
    : stopDistance * 1.8;
  const expectedGrossProfit = round2(targetDistance * approvedQty);

  if (expectedGrossProfit <= roundTripFees * 1.1) {
    return {
      decision: 'REJECTED',
      approved: false,
      approvedQty: 0,
      rule: 'FEE_DRAG_EXPECTANCY_GATE',
      reason: `Expected profit ₹${expectedGrossProfit.toFixed(1)} <= 1.1x round-trip charges (₹${roundTripFees.toFixed(1)}).`,
    };
  }

  const throttled = approvedQty < requestedQty;
  return {
    decision: throttled ? 'THROTTLED' : 'APPROVED',
    approved: true,
    approvedQty,
    rule: throttled ? 'VOLATILITY_RISK_CAP_SCALED' : 'PRE_TRADE_GATES_PASSED',
    reason: throttled
      ? `BUY ${ticker.symbol} scaled ${requestedQty} → ${approvedQty} qty (VIX ${indiaVix.toFixed(1)}, fees ₹${roundTripFees.toFixed(1)}).`
      : `BUY ${approvedQty} ${ticker.symbol} @ ₹${ticker.ltp.toFixed(2)} cleared all 11 Long-Only risk & fee gates.`,
  };
}
