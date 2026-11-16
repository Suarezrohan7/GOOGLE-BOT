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
  const news = snapshot.newsDigest;

  let regime: AiSupervisorReport['regimeAssessment'] = 'SELECTIVE';
  let throttle = 1.0;

  if (bufferPct < 8 || consec >= 3 || vix >= 22) {
    regime = 'STAND_DOWN';
    throttle = 0.25;
  } else if (
    bufferPct < 15 ||
    consec >= 2 ||
    vix >= snapshot.guardrails.vixThrottleThreshold ||
    (news && news.macroScore <= -5)
  ) {
    regime = 'DEFENSIVE';
    throttle = 0.5;
  } else if (vix < 16 && (Math.abs(snapshot.session.niftyChangePct) >= 0.4 || (news?.macroScore ?? 0) >= 2)) {
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
    const symNews = news?.symbolBias?.[t.symbol];
    if (t.rsi14 > 73 || t.rvol < 1.1 || (symNews && symNews.score <= -2)) {
      vetoedSymbols.push(t.symbol);
    } else {
      approvedSymbols.push(t.symbol);
    }
  }

  const newsBoost = news ? Math.max(-8, Math.min(8, news.macroScore * 2)) : 0;
  const conviction = Math.min(
    96,
    Math.max(30, Math.round(70 - consec * 10 + (vix < 16 ? 12 : -8) + newsBoost))
  );

  const newsSummary =
    news && news.headlines.length > 0
      ? `News: ${news.macroSentiment} (${news.headlines.length} ET/Livemint headlines)`
      : 'News: awaiting RSS sync';

  return {
    timestamp: new Date().toISOString(),
    model: 'artha-quant-deterministic-v2',
    regimeAssessment: regime,
    recommendedThrottle: throttle,
    convictionScore: conviction,
    approvedSymbols,
    vetoedSymbols,
    recommendedActions: [
      `PERMANENT CAPITAL SURVIVAL RULE: Live Equity ₹${snapshot.currentEquityInr.toFixed(0)}, Survival Floor ₹${snapshot.survivalFloorInr.toFixed(0)}. If depleted to floor (DEADMAN_LOCK), the bot stops permanently with zero restart.`,
      regime === 'STAND_DOWN'
        ? 'Volatility / drawdown throttle active at 0.25x to protect remaining capital.'
        : `Long-Only BUY Gate active (1 max slot): deploy full conviction cash into high-RVOL Equity / NIFTY CE-PE only when net expectancy beats fees. ${newsSummary}.`,
    ],
    deskSummary: `Survival Mandate Active (built-in engine): Live Capital ₹${snapshot.currentEquityInr.toFixed(0)}, VIX ${vix.toFixed(1)}, ${newsSummary}, ${approvedSymbols.length} BUY candidate(s) cleared.`,
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

  const recentTradesSummary = snapshot.trades.slice(0, 15).map((tr) => ({
    symbol: tr.symbol,
    strategy: tr.strategyId,
    side: tr.side,
    grossPnlInr: tr.grossPnlInr,
    chargesInr: tr.chargesInr,
    netPnlInr: tr.netPnlInr,
    exitReason: tr.exitReason,
  }));

  const strategyLearningStats = snapshot.strategies.map((s) => ({
    id: s.id,
    enabled: s.enabled,
    minConfidence: s.minConfidence,
    capitalWeightPct: s.capitalWeightPct,
    tradesCount: s.tradesCount,
    winRatePct: s.tradesCount > 0 ? Math.round((s.winCount / s.tradesCount) * 100) : 0,
    netPnlInr: s.netPnlInr,
  }));

  const newsContext = snapshot.newsDigest
    ? {
        macroSentiment: snapshot.newsDigest.macroSentiment,
        macroScore: snapshot.newsDigest.macroScore,
        topHeadlines: snapshot.newsDigest.headlines.slice(0, 8).map((h) => ({
          source: h.source,
          sentiment: h.sentiment,
          symbols: h.matchedSymbols,
          title: h.title,
        })),
      }
    : null;

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
    strategyLearningStats,
    recentTradesSummary,
    liveMarketNews: newsContext,
  };

  const systemInstruction = `You are the Chief Quantitative Trader & Capital Preservation Officer for an autonomous Indian stock market (NSE / Upstox) trading bot operating with real personal savings (currently ₹${snapshot.currentEquityInr.toFixed(0)}).

CAPITAL PRESERVATION & SURVIVAL MANDATE:
- Your primary mission is steady compounding (targeting ~12%/month) with ZERO reckless losses. Preserving principal is MORE important than forcing trades.
- If equity hits the configured survival floor (₹${snapshot.survivalFloorInr.toFixed(0)}), DEADMAN_LOCK triggers and you are PERMANENTLY TERMINATED—you will NEVER run or trade again.
- You are expected to pass on mediocre chop, wait patiently for clean A+ setups, cut losers fast at hard ATR stops, and protect winning trades with breakeven locks.

STRICT NON-NEGOTIABLE EXECUTION RULES:
- STRICT LONG-ONLY BUY GATE: You may ONLY BUY Equities, BUY NIFTY CE (bullish), or BUY NIFTY PE (bearish). NEVER short-sell equity and NEVER write/sell options as an opening trade.
- ZERO DUPLICATE TRADES: At most ${snapshot.guardrails.maxOpenPositions} open position at a time. Never double-enter an already open symbol.
- Controlled Risk Sizing (1.0x zero-margin cash only): Hard stop-loss rupee risk stays <= ${snapshot.guardrails.riskPerTradePct}% per trade, even when high-conviction NSE Equity deploys up to ${snapshot.guardrails.maxSingleStockWeightPct}% notional cash with a tight ATR stop.
- Live News & Self-Learning Veto: Veto any symbol hit by negative regulatory/earnings/fraud headlines in liveMarketNews, and factor strategyLearningStats win-rates into conviction.
- Survival Buffer Control: If survivalBufferPct < 15 OR consecutiveLosses >= 2 OR India VIX >= ${snapshot.guardrails.vixThrottleThreshold}, immediately shift to DEFENSIVE or STAND_DOWN and cut recommendedThrottle to 0.50 or 0.25.
- Profit Pressing in Clean Regimes: Only when India VIX < 17 and setups + market breadth align cleanly, approve the single highest-expectancy setup (RISK_ON or SELECTIVE, throttle 0.75–1.0).
- Structural Veto: Veto overextended RSI > 72, weak RVOL < 1.2, or counter-trend longs when NIFTY is dropping sharply.
- Output concise, numbers-first reasoning strictly grounded in the provided JSON.`;

  let rawText = '{}';
  try {
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('AI Supervisor 8s timeout')), 8000)
    );
    const response = await Promise.race([
      ai.models.generateContent({
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
      }),
      timeoutPromise,
    ]);
    rawText = (response.text ?? '{}').trim();
  } catch {
    return runBuiltInQuantSupervisor(snapshot, autoApplyEnabled);
  }
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
