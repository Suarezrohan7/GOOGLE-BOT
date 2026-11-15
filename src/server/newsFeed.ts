export interface NewsHeadlineItem {
  source: 'ET Markets' | 'Livemint';
  title: string;
  pubDate: string;
  sentiment: 'BULLISH' | 'NEUTRAL' | 'BEARISH';
  matchedSymbols: string[];
}

export interface MarketNewsDigest {
  fetchedAt: string | null;
  macroSentiment: 'BULLISH' | 'NEUTRAL' | 'BEARISH';
  macroScore: number;
  headlines: NewsHeadlineItem[];
  symbolBias: Record<string, { score: number; headline: string }>;
}

const RSS_FEEDS: Array<{ source: 'ET Markets' | 'Livemint'; url: string }> = [
  {
    source: 'ET Markets',
    url: 'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms',
  },
  {
    source: 'Livemint',
    url: 'https://www.livemint.com/rss/markets',
  },
];

const SYMBOL_ALIASES: Record<string, string[]> = {
  RELIANCE: ['RELIANCE', 'JIO', 'MUKESH AMBANI'],
  HDFCBANK: ['HDFC BANK', 'HDFCBANK'],
  ICICIBANK: ['ICICI BANK', 'ICICIBANK'],
  INFY: ['INFOSYS', 'INFY'],
  TCS: ['TCS', 'TATA CONSULTANCY'],
  SBIN: ['SBI', 'STATE BANK OF INDIA', 'SBIN'],
  AXISBANK: ['AXIS BANK', 'AXISBANK'],
  LT: ['L&T', 'LARSEN', 'LARSEN & TOUBRO'],
  BHARTIARTL: ['AIRTEL', 'BHARTI AIRTEL', 'BHARTIARTL'],
  WIPRO: ['WIPRO'],
  SUNPHARMA: ['SUN PHARMA', 'SUNPHARMA'],
  ITC: ['ITC LTD', 'ITC LIMITED', ' ITC '],
  NIFTY: ['NIFTY', 'SENSEX', 'DALAL STREET', 'RBI', 'FII', 'DII'],
};

const BULLISH_TERMS = [
  'SURGE',
  'RALLY',
  'JUMP',
  'GAIN',
  'BREAKOUT',
  'UPGRADE',
  'BEAT',
  'PROFIT RISES',
  'NET PROFIT UP',
  'RECORD HIGH',
  'BUY RATING',
  'INFLOW',
  'RATE CUT',
  'ORDER WIN',
  'EXPANSION',
  'STRONG Q',
  'OUTPERFORM',
];

const BEARISH_TERMS = [
  'CRASH',
  'PLUNGE',
  'SLUMP',
  'TUMBLE',
  'FALL',
  'SELL-OFF',
  'SELLOFF',
  'DOWNGRADE',
  'FRAUD',
  'SEBI BAN',
  'PENALTY',
  'PROFIT FALLS',
  'LOSS WIDENS',
  'OUTFLOW',
  'RATE HIKE',
  'WARNING',
  'DEFAULT',
  'PROBE',
  'INVESTIGATION',
];

const CACHE_TTL_MS = 10 * 60_000;
let cachedDigest: MarketNewsDigest = {
  fetchedAt: null,
  macroSentiment: 'NEUTRAL',
  macroScore: 0,
  headlines: [],
  symbolBias: {},
};
let lastFetchAttemptMs = 0;

function decodeXmlText(raw: string): string {
  return raw
    .replace(/<!\[CDATA\[/g, '')
    .replace(/\]\]>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreTitle(title: string): {
  score: number;
  sentiment: 'BULLISH' | 'NEUTRAL' | 'BEARISH';
  matchedSymbols: string[];
} {
  const upper = ` ${title.toUpperCase()} `;
  let score = 0;
  for (const w of BULLISH_TERMS) {
    if (upper.includes(w)) score += 1;
  }
  for (const w of BEARISH_TERMS) {
    if (upper.includes(w)) score -= 1;
  }

  const matchedSymbols: string[] = [];
  for (const [sym, aliases] of Object.entries(SYMBOL_ALIASES)) {
    if (aliases.some((alias) => upper.includes(alias))) {
      matchedSymbols.push(sym);
    }
  }

  const sentiment: 'BULLISH' | 'NEUTRAL' | 'BEARISH' =
    score > 0 ? 'BULLISH' : score < 0 ? 'BEARISH' : 'NEUTRAL';

  return { score, sentiment, matchedSymbols };
}

function parseRssItems(xml: string, source: 'ET Markets' | 'Livemint'): NewsHeadlineItem[] {
  const items: NewsHeadlineItem[] = [];
  const itemMatches = xml.matchAll(/<item\b[\s\S]*?<\/item>/gi);
  for (const match of itemMatches) {
    const block = match[0];
    const titleMatch = block.match(/<title>([\s\S]*?)<\/title>/i);
    if (!titleMatch?.[1]) continue;
    const title = decodeXmlText(titleMatch[1]);
    if (!title || title.length < 12) continue;

    const dateMatch = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i);
    const pubDate = dateMatch?.[1] ? decodeXmlText(dateMatch[1]) : '';
    const { sentiment, matchedSymbols } = scoreTitle(title);

    items.push({
      source,
      title,
      pubDate,
      sentiment,
      matchedSymbols,
    });
    if (items.length >= 8) break;
  }
  return items;
}

export async function refreshMarketNewsDigest(force = false): Promise<MarketNewsDigest> {
  const nowMs = Date.now();
  if (!force && cachedDigest.fetchedAt && nowMs - lastFetchAttemptMs < CACHE_TTL_MS) {
    return cachedDigest;
  }
  if (!force && nowMs - lastFetchAttemptMs < 60_000) {
    return cachedDigest;
  }
  lastFetchAttemptMs = nowMs;

  const allItems: NewsHeadlineItem[] = [];
  await Promise.all(
    RSS_FEEDS.map(async (feed) => {
      try {
        const resp = await fetch(feed.url, {
          headers: {
            Accept: 'application/rss+xml, application/xml, text/xml',
            'User-Agent': 'ArthaQuant-NewsReader/1.0',
          },
          signal: AbortSignal.timeout(4500),
        });
        if (!resp.ok) return;
        const xml = await resp.text();
        allItems.push(...parseRssItems(xml, feed.source));
      } catch {
        // Non-fatal: RSS timeout never blocks trading loop
      }
    })
  );

  if (allItems.length === 0) {
    return cachedDigest;
  }

  // Deduplicate similar headlines
  const seen = new Set<string>();
  const headlines: NewsHeadlineItem[] = [];
  for (const item of allItems) {
    const key = item.title.toLowerCase().slice(0, 48);
    if (seen.has(key)) continue;
    seen.add(key);
    headlines.push(item);
    if (headlines.length >= 14) break;
  }

  let rawMacro = 0;
  const symbolBias: Record<string, { score: number; headline: string }> = {};
  for (const h of headlines) {
    const { score } = scoreTitle(h.title);
    rawMacro += score;
    for (const sym of h.matchedSymbols) {
      if (!symbolBias[sym]) {
        symbolBias[sym] = { score, headline: h.title };
      } else {
        symbolBias[sym].score += score;
      }
    }
  }

  const macroScore = Math.max(-10, Math.min(10, rawMacro));
  const macroSentiment: MarketNewsDigest['macroSentiment'] =
    macroScore >= 2 ? 'BULLISH' : macroScore <= -2 ? 'BEARISH' : 'NEUTRAL';

  cachedDigest = {
    fetchedAt: new Date().toISOString(),
    macroSentiment,
    macroScore,
    headlines,
    symbolBias,
  };
  return cachedDigest;
}

export function getCachedMarketNewsDigest(): MarketNewsDigest {
  return cachedDigest;
}
