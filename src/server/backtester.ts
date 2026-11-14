import type {
  BacktestRequest,
  BacktestResult,
  EquityPoint,
  GuardrailsConfig,
  StrategyConfig,
  StrategyId,
} from '../shared/types.ts';
import { calculateIndianTransactionCosts, round2 } from './indiaMarket.ts';
import { computeSurvivalFloor } from './riskEngine.ts';
import { fetchUpstoxHistoricalCandles, getUpstoxAccessToken } from './upstoxClient.ts';

/**
 * Runs a walk-forward backtest strictly against real NSE historical daily/intraday
 * candles fetched from Upstox Historical Candle Data V3 API.
 */
export async function runUpstoxHistoricalBacktest(
  req: BacktestRequest,
  guardrails: GuardrailsConfig,
  strategies: StrategyConfig[]
): Promise<BacktestResult> {
  const days = Math.min(180, Math.max(10, Math.round(req.days || 60)));

  if (!getUpstoxAccessToken()) {
    throw new Error(
      'Upstox access token is required to fetch real NSE historical candles from Upstox V3 API.'
    );
  }

  const toDate = new Date().toISOString().slice(0, 10);
  const fromDateObj = new Date(Date.now() - (days + 25) * 24 * 60 * 60 * 1000);
  const fromDate = fromDateObj.toISOString().slice(0, 10);

  const symbols = ['ITC', 'SBIN', 'TATAMOTORS', 'AXISBANK', 'ICICIBANK', 'RELIANCE'];
  const symbolCandles: Record<
    string,
    Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }>
  > = {};

  for (const sym of symbols) {
    const res = await fetchUpstoxHistoricalCandles(sym, 'days', 1, fromDate, toDate);
    if (!res.ok) {
      throw new Error(`Upstox V3 candle fetch failed for ${sym}: ${res.error}`);
    }
    // Upstox returns newest-first [timestamp, open, high, low, close, volume, oi]
    const ordered = [...res.candles].reverse().map((c) => ({
      date: String(c[0]).slice(0, 10),
      open: Number(c[1]),
      high: Number(c[2]),
      low: Number(c[3]),
      close: Number(c[4]),
      volume: Number(c[5]),
    }));
    symbolCandles[sym] = ordered;
  }

  const referenceDates = (symbolCandles[symbols[0]] || []).slice(-days).map((c) => c.date);
  if (referenceDates.length < 5) {
    throw new Error('Insufficient historical NSE candles returned by Upstox V3 API.');
  }

  const startingCapital = guardrails.allocatedCapitalInr;
  let equity = startingCapital;
  let peakEquity = startingCapital;
  let maxDrawdownPct = 0;
  let totalCharges = 0;
  let totalTrades = 0;
  let wins = 0;
  let grossProfitSum = 0;
  let grossLossSum = 0;
  let rejectedByRiskCount = 0;
  let survived = true;
  let survivalStatusReason =
    'All drawdown floors & Upstox fee-drag gates held across real NSE historical candles.';

  const stratStats: Record<
    StrategyId,
    { name: string; trades: number; wins: number; netPnl: number }
  > = {
    ORB_VWAP: { name: 'ORB + VWAP Momentum', trades: 0, wins: 0, netPnl: 0 },
    MEAN_REVERSION: { name: 'Bollinger Z-Score Reversion', trades: 0, wins: 0, netPnl: 0 },
    PAIRS_SPREAD: { name: 'Sector Pairs Spread', trades: 0, wins: 0, netPnl: 0 },
  };

  const dailyReturns: number[] = [];
  const equityCurve: EquityPoint[] = [
    {
      timestamp: referenceDates[0],
      label: referenceDates[0],
      equityInr: round2(startingCapital),
      drawdownPct: 0,
      survivalFloorInr: computeSurvivalFloor(
        peakEquity,
        guardrails.maxTotalDrawdownPct,
        startingCapital
      ),
    },
  ];

  const enabledIds = new Set(strategies.filter((s) => s.enabled).map((s) => s.id));

  for (let dIdx = 5; dIdx < referenceDates.length; dIdx++) {
    if (!survived) break;
    const date = referenceDates[dIdx];
    const dayStartEquity = equity;
    const survivalFloor = computeSurvivalFloor(
      peakEquity,
      guardrails.maxTotalDrawdownPct,
      startingCapital
    );
    const maxDailyLossInr = guardrails.allocatedCapitalInr * (guardrails.maxDailyLossPct / 100);
    let dailyPnl = 0;

    for (const sym of symbols) {
      if (dailyPnl <= -maxDailyLossInr) {
        rejectedByRiskCount++;
        break;
      }

      const series = symbolCandles[sym];
      const idx = series.findIndex((c) => c.date === date);
      if (idx < 5) continue;

      const today = series[idx];
      const prev5 = series.slice(idx - 5, idx);
      const avgVol = prev5.reduce((a, c) => a + c.volume, 0) / 5;
      const avgClose = prev5.reduce((a, c) => a + c.close, 0) / 5;
      const avgRange = prev5.reduce((a, c) => a + (c.high - c.low), 0) / 5;

      const rvol = avgVol > 0 ? today.volume / avgVol : 1;
      const zScore = avgRange > 0 ? (today.open - avgClose) / avgRange : 0;

      let chosenStrategy: StrategyId | null = null;
      const side: 'BUY' = 'BUY';

      if (enabledIds.has('ORB_VWAP') && rvol >= 1.25 && today.open > avgClose) {
        chosenStrategy = 'ORB_VWAP';
      } else if (enabledIds.has('MEAN_REVERSION') && zScore <= -1.2) {
        chosenStrategy = 'MEAN_REVERSION';
      } else if (enabledIds.has('PAIRS_SPREAD') && sym === 'ICICIBANK' && today.open >= avgClose) {
        chosenStrategy = 'PAIRS_SPREAD';
      }

      if (!chosenStrategy) continue;

      const maxStockNotional = equity * (guardrails.maxSingleStockWeightPct / 100);
      const stopDistance = Math.max(avgRange * 0.65, today.open * 0.006);
      const riskBudget = equity * (guardrails.riskPerTradePct / 100);

      const qty = Math.min(
        Math.floor(riskBudget / stopDistance),
        Math.floor(maxStockNotional / today.open)
      );

      if (qty < 1) {
        rejectedByRiskCount++;
        continue;
      }

      const entryCost = calculateIndianTransactionCosts(
        today.open,
        qty,
        'BUY',
        guardrails.productType
      ).totalChargesInr;
      const exitCost = calculateIndianTransactionCosts(
        today.close,
        qty,
        'SELL',
        guardrails.productType
      ).totalChargesInr;
      const roundTripFees = round2(entryCost + exitCost);

      // Fee-drag gate (1.1x minimum break-even cover)
      if (stopDistance * 1.8 * qty <= roundTripFees * 1.1) {
        rejectedByRiskCount++;
        continue;
      }

      const rawMove = today.close - today.open;
      // Apply realistic intraday stop/target clamp using day high/low (Long-Only BUY)
      const targetMove = stopDistance * 1.8;
      let realizedMove = rawMove;
      if (today.low <= today.open - stopDistance) realizedMove = -stopDistance;
      else if (today.high >= today.open + targetMove) realizedMove = targetMove;

      const grossPnl = round2(realizedMove * qty);
      const netPnl = round2(grossPnl - roundTripFees);

      dailyPnl += netPnl;
      equity = round2(equity + netPnl);
      totalCharges = round2(totalCharges + roundTripFees);
      totalTrades++;

      stratStats[chosenStrategy].trades++;
      stratStats[chosenStrategy].netPnl = round2(stratStats[chosenStrategy].netPnl + netPnl);

      if (netPnl > 0) {
        wins++;
        stratStats[chosenStrategy].wins++;
        grossProfitSum += netPnl;
      } else {
        grossLossSum += Math.abs(netPnl);
      }

      if (equity > peakEquity) peakEquity = equity;
      const ddPct = peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0;
      if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;

      if (equity <= survivalFloor) {
        survived = false;
        survivalStatusReason = `${date}: Equity ₹${equity.toFixed(0)} hit survival floor ₹${survivalFloor.toFixed(0)}. Dead-man lock engaged.`;
        break;
      }

      // Max 1 trade per day/slot when single-position mode is active
      if (guardrails.maxOpenPositions <= 1) {
        break;
      }
    }

    const dayRet = dayStartEquity > 0 ? (equity - dayStartEquity) / dayStartEquity : 0;
    dailyReturns.push(dayRet);

    const ddNow = peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0;
    equityCurve.push({
      timestamp: date,
      label: date.slice(5),
      equityInr: round2(equity),
      drawdownPct: round2(ddNow),
      survivalFloorInr: computeSurvivalFloor(
        peakEquity,
        guardrails.maxTotalDrawdownPct,
        startingCapital
      ),
    });
  }

  const avgDailyRet =
    dailyReturns.reduce((acc, r) => acc + r, 0) / Math.max(1, dailyReturns.length);
  const variance =
    dailyReturns.reduce((acc, r) => acc + Math.pow(r - avgDailyRet, 2), 0) /
    Math.max(1, dailyReturns.length);
  const stdDev = Math.sqrt(variance);
  const sharpeRatio = stdDev > 0 ? round2((avgDailyRet / stdDev) * Math.sqrt(252)) : 0;
  const profitFactor =
    grossLossSum > 0 ? round2(grossProfitSum / grossLossSum) : grossProfitSum > 0 ? 9.99 : 0;

  return {
    daysSimulated: equityCurve.length - 1,
    dataSource: 'UPSTOX_V3_HISTORICAL_CANDLES',
    startingCapitalInr: round2(startingCapital),
    endingCapitalInr: round2(equity),
    netReturnPct: round2(((equity - startingCapital) / startingCapital) * 100),
    maxDrawdownPct: round2(maxDrawdownPct),
    survivalFloorInr: computeSurvivalFloor(
      peakEquity,
      guardrails.maxTotalDrawdownPct,
      startingCapital
    ),
    survived,
    survivalStatusReason,
    sharpeRatio,
    profitFactor,
    winRatePct: totalTrades > 0 ? round2((wins / totalTrades) * 100) : 0,
    totalTrades,
    rejectedByRiskCount,
    totalStatutoryChargesInr: round2(totalCharges),
    equityCurve,
    strategyBreakdown: (Object.keys(stratStats) as StrategyId[]).map((id) => ({
      strategyId: id,
      name: stratStats[id].name,
      trades: stratStats[id].trades,
      winRatePct:
        stratStats[id].trades > 0
          ? round2((stratStats[id].wins / stratStats[id].trades) * 100)
          : 0,
      netPnlInr: round2(stratStats[id].netPnl),
    })),
  };
}
