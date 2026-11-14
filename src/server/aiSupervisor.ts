import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import type { AiSupervisorReport, BotStateSnapshot } from '../shared/types.ts';

const MODEL_NAME = 'gemini-4-hydrogen';

function createGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    return null;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function runBuiltInQuantSupervisor(
  snapshot: BotStateSnapshot,
  autoApplyEnabled: boolean
): AiSupervisorReport {
  const vix = snapshot.session.indiaVix;
  const bufferPct = snapshot.survivalBufferPct;
  const consec = snapshot.consecutiveLosses;

  let regime: AiSupervisorReport['regimeAssessment'] = 'SELECTIVE';
  let throttle = 1.0;

  if (bufferPct < 8 || consec >= 3 || vix >= 22) {
    regime = 'STAND_DOWN';
    throttle = 0.25;
  } else if (bufferPct < 15 || consec >= 2 || vix >= snapshot.guardrails.vixThrottleThreshold) {
    regime = 'DEFENSIVE';
    throttle = 0.5;
  } else if (vix < 16 && Math.abs(snapshot.session.niftyChangePct) >= 0.4) {
    regime = 'RISK_ON';
    throttle = 1.0;
  } else {
    regime = 'SELECTIVE';
    throttle = 0.75;
  }

  const activeTickers = snapshot.tickers.filter((t) => t.signal !== null && t.signalSide === 'BUY');
  const approvedSymbols: string[] = [];
  const vetoedSymbols: string[] = [];

  for (const t of activeTickers) {
    if (t.rsi14 > 73 || t.rvol < 1.1) {
      vetoedSymbols.push(t.symbol);
    } else {
      approvedSymbols.push(t.symbol);
    }
  }

  const conviction = Math.min(
    95,
    Math.max(30, Math.round(70 - consec * 10 + (vix < 16 ? 12 : -8)))
  );

  return {
    timestamp: new Date().toISOString(),
    model: 'artha-quant-deterministic-v1',
    regimeAssessment: regime,
    recommendedThrottle: throttle,
    convictionScore: conviction,
    approvedSymbols,
    vetoedSymbols,
    recommendedActions: [
      `PERMANENT CAPITAL SURVIVAL RULE: Live Equity ₹${snapshot.currentEquityInr.toFixed(0)}, Survival Floor ₹${snapshot.survivalFloorInr.toFixed(0)}. If depleted to floor (DEADMAN_LOCK), the bot stops permanently with zero restart.`,
      regime === 'STAND_DOWN'
        ? 'Volatility / drawdown throttle active at 0.25x to protect remaining capital.'
        : 'Long-Only BUY Gate active (1 max slot): deploy meaningfully into high-RVOL Equity / NIFTY CE-PE only when net expectancy beats fees.',
    ],
    deskSummary: `Survival Mandate Active (built-in engine): Live Capital ₹${snapshot.currentEquityInr.toFixed(0)}, VIX ${vix.toFixed(1)}, Floor ₹${snapshot.survivalFloorInr.toFixed(0)}, ${approvedSymbols.length} BUY candidate(s) cleared.`,
    taxDragAssessment: `Total Upstox charges paid ₹${snapshot.totalChargesPaidInr.toFixed(2)}; 1.1x round-trip fee gate active.`,
    autoApplyEnabled,
  };
}

export async function runAiMarketSupervisor(
  snapshot: BotStateSnapshot,
  autoApplyEnabled: boolean
): Promise<AiSupervisorReport> {
  const ai = createGeminiClient();
  if (!ai) {
    return runBuiltInQuantSupervisor(snapshot, autoApplyEnabled);
  }

  const candidateSignals = snapshot.tickers
    .filter((t) => t.signal !== null)
    .map((t) => ({
      symbol: t.symbol,
      sector: t.sector,
      ltp: t.ltp,
      vwap: t.vwap,
      changePct: t.changePct,
      rsi14: t.rsi14,
      zScore: t.zScore,
      rvol: t.rvol,
      atr14: t.atr14,
      signal: t.signal,
      side: t.signalSide,
      confidence: t.signalConfidence,
    }));

  const recentTradesSummary = snapshot.trades.slice(0, 10).map((tr) => ({
    symbol: tr.symbol,
    strategy: tr.strategyId,
    side: tr.side,
    grossPnlInr: tr.grossPnlInr,
    chargesInr: tr.chargesInr,
    netPnlInr: tr.netPnlInr,
    exitReason: tr.exitReason,
  }));

  const promptPayload = {
    marketSession: snapshot.session,
    capitalHealth: {
      upstoxLiveBalanceInr: snapshot.upstoxLiveBalanceInr,
      currentEquityInr: snapshot.currentEquityInr,
      peakEquityInr: snapshot.peakEquityInr,
      survivalFloorInr: snapshot.survivalFloorInr,
      survivalBufferPct: snapshot.survivalBufferPct,
      dailyPnlInr: snapshot.dailyPnlInr,
      dailyPnlPct: snapshot.dailyPnlPct,
      maxDailyLossPct: snapshot.guardrails.maxDailyLossPct,
      maxDrawdownSeenPct: snapshot.maxDrawdownSeenPct,
      consecutiveLosses: snapshot.consecutiveLosses,
      winRatePct: snapshot.winRatePct,
      profitFactor: snapshot.profitFactor,
      totalChargesPaidInr: snapshot.totalChargesPaidInr,
      totalRealizedPnlInr: snapshot.totalRealizedPnlInr,
    },
    activePositions: snapshot.positions.map((p) => ({
      symbol: p.symbol,
      sector: p.sector,
      side: p.side,
      strategyId: p.strategyId,
      unrealizedPnlInr: p.unrealizedPnlInr,
    })),
    candidateSignals,
    recentTradesSummary,
  };

  const systemInstruction = `You are the Chief Quantitative Trader & Survival Officer for an autonomous Indian stock market (NSE / Upstox) trading bot operating with live Upstox account capital (currently ₹${snapshot.currentEquityInr.toFixed(0)}).

EXISTENTIAL SURVIVAL MANDATE (NO SECOND CHANCES):
- Your Upstox account equity is your ONLY life. There are NO automatic top-ups, NO bailouts, and NO restarts if you blow it to ₹0 / the survival floor (₹${snapshot.survivalFloorInr.toFixed(0)}).
- If equity hits ₹0 (or the configured survival floor), DEADMAN_LOCK triggers and you are PERMANENTLY TERMINATED—you will NEVER run or trade again.
- You are allowed to weather drawdowns and recover aggressively if you have edge, BUT if you run your account down to ₹0 you die forever. Protect capital ruthlessly with hard stops while compounding real net profit after Upstox charges.

STRICT NON-NEGOTIABLE EXECUTION RULES:
- STRICT LONG-ONLY BUY GATE: You may ONLY BUY Equities, BUY NIFTY CE (bullish), or BUY NIFTY PE (bearish). NEVER short-sell equity and NEVER write/sell options as an opening trade.
- ZERO DUPLICATE TRADES: At most ${snapshot.guardrails.maxOpenPositions} open position at a time. Never double-enter an already open symbol.
- Meaningful Capital Sizing: With riskPerTradePct=${snapshot.guardrails.riskPerTradePct}% and maxSingleStockWeightPct=${snapshot.guardrails.maxSingleStockWeightPct}%, approve full high-conviction BUY sizing when net profit target exceeds 1.1x round-trip Upstox charges.
- Survival Buffer Control: If currentEquityInr <= 0 OR consecutiveLosses >= 3 OR India VIX >= 19, immediately shift to DEFENSIVE or STAND_DOWN and cut recommendedThrottle to 0.50 or 0.25.
- Profit Pressing in Clean Regimes: When India VIX < 17 and setups align cleanly, approve the single highest-expectancy setup (RISK_ON or SELECTIVE, throttle 0.75–1.0).
- Structural Veto: Veto overextended RSI > 73 or low-volume fakeouts.
- Output concise, numbers-first reasoning strictly grounded in the provided JSON.`;

  const response = await ai.models.generateContent({
    model: MODEL_NAME,
    contents: `Evaluate current NSE portfolio and signal slate:\n${JSON.stringify(promptPayload)}`,
    config: {
      systemInstruction,
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          regimeAssessment: {
            type: Type.STRING,
            description: 'One of: RISK_ON, SELECTIVE, DEFENSIVE, STAND_DOWN',
          },
          recommendedThrottle: {
            type: Type.NUMBER,
            description: 'Position size scalar between 0.25 and 1.0',
          },
          convictionScore: {
            type: Type.INTEGER,
            description: 'Integer 0-100 reflecting setup quality and survival headroom',
          },
          approvedSymbols: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'Symbols cleared for entry',
          },
          vetoedSymbols: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'Symbols vetoed due to noise, correlation, or VIX risk',
          },
          recommendedActions: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: '2 to 4 concrete risk or strategy actions',
          },
          deskSummary: {
            type: Type.STRING,
            description: '2-3 sentence institutional risk & market regime summary',
          },
          taxDragAssessment: {
            type: Type.STRING,
            description: '1-2 sentence assessment of STT/brokerage/slippage drag vs gross PnL',
          },
        },
        required: [
          'regimeAssessment',
          'recommendedThrottle',
          'convictionScore',
          'approvedSymbols',
          'vetoedSymbols',
          'recommendedActions',
          'deskSummary',
          'taxDragAssessment',
        ],
      },
    },
  });

  const rawText = (response.text ?? '{}').trim();
  const parsed = JSON.parse(rawText) as Partial<AiSupervisorReport>;

  const validRegimes = ['RISK_ON', 'SELECTIVE', 'DEFENSIVE', 'STAND_DOWN'] as const;
  const regime = validRegimes.includes(parsed.regimeAssessment as (typeof validRegimes)[number])
    ? (parsed.regimeAssessment as AiSupervisorReport['regimeAssessment'])
    : 'SELECTIVE';

  const rawThrottle = Number(parsed.recommendedThrottle ?? 0.75);
  const clampedThrottle = Math.min(1.0, Math.max(0.25, Math.round(rawThrottle * 4) / 4));

  return {
    timestamp: new Date().toISOString(),
    model: MODEL_NAME,
    regimeAssessment: regime,
    recommendedThrottle: clampedThrottle,
    convictionScore: Math.min(100, Math.max(0, Math.round(Number(parsed.convictionScore ?? 65)))),
    approvedSymbols: Array.isArray(parsed.approvedSymbols) ? parsed.approvedSymbols : [],
    vetoedSymbols: Array.isArray(parsed.vetoedSymbols) ? parsed.vetoedSymbols : [],
    recommendedActions: Array.isArray(parsed.recommendedActions)
      ? parsed.recommendedActions.slice(0, 4)
      : ['Maintain volatility-adjusted sizing and monitor survival buffer.'],
    deskSummary:
      parsed.deskSummary ||
      'AI Supervisor evaluated current NIFTY breadth, VIX throttle, and survival buffer.',
    taxDragAssessment:
      parsed.taxDragAssessment ||
      'Monitor statutory STT and brokerage turnover ratio against gross profit per trade.',
    autoApplyEnabled,
  };
}
