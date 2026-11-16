import fs from 'node:fs';
import path from 'node:path';

/**
 * Upstox API v2 / v3 Official NSE_EQ ISIN Instrument Registry & REST / WebSocket Client
 * Credentials are read strictly from server-side environment variables + server OAuth token cache.
 */

const TOKEN_FILE = path.resolve(process.cwd(), 'data', 'upstox-token.json');

interface StoredToken {
  accessToken: string;
  obtainedAt: string;
}

export function getUpstoxAccessToken(): string | null {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const raw = fs.readFileSync(TOKEN_FILE, 'utf-8');
      const parsed = JSON.parse(raw) as StoredToken;
      if (parsed?.accessToken && parsed.accessToken.trim()) {
        return parsed.accessToken.trim();
      }
    }
  } catch {
    // Ignore read error
  }
  if (process.env.UPSTOX_ACCESS_TOKEN && process.env.UPSTOX_ACCESS_TOKEN.trim()) {
    return process.env.UPSTOX_ACCESS_TOKEN.trim();
  }
  return null;
}

export function saveUpstoxAccessToken(accessToken: string): void {
  try {
    const dir = path.dirname(TOKEN_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const payload: StoredToken = {
      accessToken,
      obtainedAt: new Date().toISOString(),
    };
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(payload, null, 2), 'utf-8');
    process.env.UPSTOX_ACCESS_TOKEN = accessToken;
  } catch {
    process.env.UPSTOX_ACCESS_TOKEN = accessToken;
  }
}

export async function exchangeUpstoxAuthCode(
  code: string,
  fallbackRedirectUri?: string
): Promise<{
  ok: boolean;
  accessToken?: string;
  error?: string;
}> {
  const clientId = process.env.UPSTOX_API_KEY;
  const clientSecret = process.env.UPSTOX_API_SECRET;
  const redirectUri =
    process.env.UPSTOX_REDIRECT_URI ||
    (process.env.APP_URL ? `${process.env.APP_URL.replace(/\/$/, '')}/api/upstox/callback` : '') ||
    fallbackRedirectUri ||
    '';

  if (!clientId || !clientSecret || !redirectUri) {
    return {
      ok: false,
      error: 'UPSTOX_API_KEY, UPSTOX_API_SECRET, and UPSTOX_REDIRECT_URI must be set on the server.',
    };
  }

  try {
    const body = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });

    const resp = await fetch('https://api.upstox.com/v2/login/authorization/token', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    const json = (await resp.json()) as {
      access_token?: string;
      errors?: Array<{ message?: string }>;
      message?: string;
    };

    if (!resp.ok || !json.access_token) {
      return {
        ok: false,
        error: json.errors?.[0]?.message || json.message || `Upstox OAuth HTTP ${resp.status}`,
      };
    }

    saveUpstoxAccessToken(json.access_token);
    return { ok: true, accessToken: json.access_token };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Upstox OAuth code exchange failed.',
    };
  }
}

export async function requestUpstoxAccessTokenViaNotifier(): Promise<{
  ok: boolean;
  message?: string;
  error?: string;
}> {
  const clientId = process.env.UPSTOX_API_KEY;
  const clientSecret = process.env.UPSTOX_API_SECRET;
  if (!clientId || !clientSecret) {
    return {
      ok: false,
      error: 'UPSTOX_API_KEY and UPSTOX_API_SECRET must be set on the server.',
    };
  }

  try {
    const resp = await fetch(
      `https://api.upstox.com/v3/login/auth/token/request/${encodeURIComponent(clientId)}`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ client_secret: clientSecret }),
        signal: AbortSignal.timeout(7000),
      }
    );
    const json = (await resp.json()) as {
      status?: string;
      message?: string;
      errors?: Array<{ message?: string }>;
    };
    if (!resp.ok || json.status === 'error') {
      return {
        ok: false,
        error: json.errors?.[0]?.message || json.message || `Upstox Token Request HTTP ${resp.status}`,
      };
    }
    return {
      ok: true,
      message:
        json.message ||
        'Approval prompt sent to your Upstox Mobile App & WhatsApp. Tap Approve to auto-connect.',
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Upstox v3 token request failed.',
    };
  }
}

export const UPSTOX_NSE_ISIN_MAP: Record<string, string> = {
  RELIANCE: 'NSE_EQ|INE002A01018',
  HDFCBANK: 'NSE_EQ|INE040A01034',
  ICICIBANK: 'NSE_EQ|INE090A01021',
  INFY: 'NSE_EQ|INE009A01021',
  TCS: 'NSE_EQ|INE467B01029',
  SBIN: 'NSE_EQ|INE062A01020',
  AXISBANK: 'NSE_EQ|INE238A01034',
  LT: 'NSE_EQ|INE018A01030',
  BHARTIARTL: 'NSE_EQ|INE397D01024',
  TATAMOTORS: 'NSE_EQ|INE155A01022',
  WIPRO: 'NSE_EQ|INE075A01022',
  HINDUNILVR: 'NSE_EQ|INE030A01027',
  SUNPHARMA: 'NSE_EQ|INE044A01036',
  ITC: 'NSE_EQ|INE154A01025',
};

export function resolveUpstoxInstrumentKey(symbol: string): string {
  const upper = symbol.toUpperCase();
  return UPSTOX_NSE_ISIN_MAP[upper] || `NSE_EQ|${upper}`;
}

export interface UpstoxQuoteResult {
  symbol: string;
  instrumentKey: string;
  ltp: number;
  open: number;
  high: number;
  low: number;
  prevClose: number;
  volume: number;
  vwap: number;
}

export async function authorizeUpstoxWebsocket(): Promise<{
  ok: boolean;
  authorizedRedirectUri?: string;
  error?: string;
}> {
  const token = getUpstoxAccessToken();
  if (!token) {
    return {
      ok: false,
      error: 'UPSTOX_ACCESS_TOKEN not configured in server environment.',
    };
  }

  try {
    const resp = await fetch(
      'https://api.upstox.com/v3/feed/market-data-feed/authorize',
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(8000),
      }
    );
    const json = (await resp.json()) as {
      status?: string;
      data?: { authorized_redirect_uri?: string };
      errors?: Array<{ message?: string }>;
    };
    if (!resp.ok || json.status === 'error') {
      return {
        ok: false,
        error: json.errors?.[0]?.message || `Upstox WS Auth HTTP ${resp.status}`,
      };
    }
    return {
      ok: true,
      authorizedRedirectUri: json.data?.authorized_redirect_uri,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Upstox WebSocket authorize failed.',
    };
  }
}

export async function fetchUpstoxHistoricalCandles(
  symbol: string,
  unit: 'minutes' | 'hours' | 'days',
  interval: number,
  fromDate: string,
  toDate: string
): Promise<{
  ok: boolean;
  candles: Array<[string, number, number, number, number, number, number]>;
  error?: string;
}> {
  const token = getUpstoxAccessToken();
  if (!token) {
    return {
      ok: false,
      candles: [],
      error: 'UPSTOX_ACCESS_TOKEN not configured in server environment.',
    };
  }

  const key = encodeURIComponent(resolveUpstoxInstrumentKey(symbol));
  const url = `https://api.upstox.com/v3/historical-candle/${key}/${unit}/${interval}/${toDate}/${fromDate}`;

  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(8000),
    });
    const json = (await resp.json()) as {
      status?: string;
      data?: { candles?: Array<[string, number, number, number, number, number, number]> };
      errors?: Array<{ message?: string }>;
    };
    if (!resp.ok || json.status === 'error') {
      return {
        ok: false,
        candles: [],
        error: json.errors?.[0]?.message || `Upstox V3 Candle HTTP ${resp.status}`,
      };
    }
    return { ok: true, candles: json.data?.candles ?? [] };
  } catch (err) {
    return {
      ok: false,
      candles: [],
      error: err instanceof Error ? err.message : 'Upstox historical candle fetch failed.',
    };
  }
}

export async function fetchUpstoxIntradayCandles(
  symbol: string,
  unit: 'minutes' | 'hours' = 'minutes',
  interval = 5
): Promise<{
  ok: boolean;
  candles: Array<[string, number, number, number, number, number, number]>;
  error?: string;
}> {
  const token = getUpstoxAccessToken();
  if (!token) {
    return { ok: false, candles: [], error: 'Missing Upstox token.' };
  }

  const key = encodeURIComponent(resolveUpstoxInstrumentKey(symbol));
  const url = `https://api.upstox.com/v3/historical-candle/intraday/${key}/${unit}/${interval}`;

  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(8000),
    });
    const json = (await resp.json()) as {
      status?: string;
      data?: { candles?: Array<[string, number, number, number, number, number, number]> };
      errors?: Array<{ message?: string }>;
    };
    if (!resp.ok || json.status === 'error') {
      return {
        ok: false,
        candles: [],
        error: json.errors?.[0]?.message || `Upstox V3 Intraday HTTP ${resp.status}`,
      };
    }
    return { ok: true, candles: json.data?.candles ?? [] };
  } catch (err) {
    return {
      ok: false,
      candles: [],
      error: err instanceof Error ? err.message : 'Upstox intraday candle fetch failed.',
    };
  }
}

export async function fetchUpstoxFunds(): Promise<{
  ok: boolean;
  availableMarginInr?: number;
  usedMarginInr?: number;
  error?: string;
}> {
  const token = getUpstoxAccessToken();
  if (!token) {
    return { ok: false, error: 'UPSTOX_ACCESS_TOKEN not configured in server environment.' };
  }

  try {
    const resp = await fetch(
      'https://api.upstox.com/v2/user/get-funds-and-margin?segment=SEC',
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(7000),
      }
    );

    const json = (await resp.json()) as {
      status?: string;
      data?: {
        equity?: {
          available_margin?: number;
          used_margin?: number;
        };
      };
      errors?: Array<{ message?: string }>;
    };

    if (!resp.ok || json.status === 'error') {
      return {
        ok: false,
        error: json.errors?.[0]?.message || `Upstox HTTP ${resp.status}`,
      };
    }

    return {
      ok: true,
      availableMarginInr: Number(json.data?.equity?.available_margin ?? 0),
      usedMarginInr: Number(json.data?.equity?.used_margin ?? 0),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Upstox funds lookup failed.',
    };
  }
}

export async function fetchUpstoxNseQuotes(
  symbols: string[]
): Promise<{ ok: boolean; quotes: UpstoxQuoteResult[]; error?: string }> {
  const token = getUpstoxAccessToken();
  if (!token) {
    return {
      ok: false,
      quotes: [],
      error: 'UPSTOX_ACCESS_TOKEN not configured in server environment.',
    };
  }

  const keys = symbols.map(resolveUpstoxInstrumentKey);
  const url = `https://api.upstox.com/v2/market-quote/quotes?instrument_key=${encodeURIComponent(
    keys.join(',')
  )}`;

  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(7000),
    });

    const json = (await resp.json()) as {
      status?: string;
      data?: Record<
        string,
        {
          last_price?: number;
          average_price?: number;
          volume?: number;
          ohlc?: { open?: number; high?: number; low?: number; close?: number };
        }
      >;
      errors?: Array<{ message?: string }>;
    };

    if (!resp.ok || json.status === 'error' || !json.data) {
      return {
        ok: false,
        quotes: [],
        error: json.errors?.[0]?.message || `Upstox quotes HTTP ${resp.status}`,
      };
    }

    const quotes: UpstoxQuoteResult[] = [];
    for (const sym of symbols) {
      const ikey = resolveUpstoxInstrumentKey(sym);
      const entry =
        json.data[ikey] || json.data[`NSE_EQ:${sym}`] || json.data[ikey.replace('|', ':')];
      if (!entry || !entry.last_price) continue;
      quotes.push({
        symbol: sym,
        instrumentKey: ikey,
        ltp: Number(entry.last_price),
        open: Number(entry.ohlc?.open ?? entry.last_price),
        high: Number(entry.ohlc?.high ?? entry.last_price),
        low: Number(entry.ohlc?.low ?? entry.last_price),
        prevClose: Number(entry.ohlc?.close ?? entry.last_price),
        volume: Number(entry.volume ?? 0),
        vwap: Number(entry.average_price ?? entry.last_price),
      });
    }

    return { ok: true, quotes };
  } catch (err) {
    return {
      ok: false,
      quotes: [],
      error: err instanceof Error ? err.message : 'Upstox quotes request failed.',
    };
  }
}

export interface UpstoxOpenPosition {
  symbol: string;
  instrumentToken: string;
  product: string;
  quantity: number;
  averagePrice: number;
  lastPrice: number;
  pnl: number;
  dayBuyQty: number;
  dayBuyPrice: number;
  daySellQty: number;
  daySellPrice: number;
  realizedPnl: number;
}

export async function fetchUpstoxPositions(): Promise<{
  ok: boolean;
  positions: UpstoxOpenPosition[];
  dayPositions?: UpstoxOpenPosition[];
  error?: string;
}> {
  const token = getUpstoxAccessToken();
  if (!token) {
    return {
      ok: false,
      positions: [],
      error: 'UPSTOX_ACCESS_TOKEN not configured in server environment.',
    };
  }

  try {
    const resp = await fetch('https://api.upstox.com/v2/portfolio/short-term-positions', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(7000),
    });
    const json = (await resp.json()) as {
      status?: string;
      data?: Array<{
        trading_symbol?: string;
        instrument_token?: string;
        product?: string;
        quantity?: number;
        average_price?: number;
        last_price?: number;
        pnl?: number;
        realised?: number;
        day_buy_quantity?: number;
        day_buy_price?: number;
        buy_price?: number;
        day_sell_quantity?: number;
        day_sell_price?: number;
        sell_price?: number;
      }>;
      errors?: Array<{ message?: string }>;
    };

    if (!resp.ok || json.status === 'error') {
      return {
        ok: false,
        positions: [],
        error: json.errors?.[0]?.message || `Upstox positions HTTP ${resp.status}`,
      };
    }

    const mappedAll: UpstoxOpenPosition[] = (json.data ?? [])
      .filter((p) => Number(p.quantity ?? 0) !== 0 || Number(p.day_buy_quantity ?? 0) > 0)
      .map((p) => ({
        symbol: String(p.trading_symbol || '').replace(/-EQ$/i, '').toUpperCase(),
        instrumentToken: String(p.instrument_token || ''),
        product: String(p.product || 'I'),
        quantity: Number(p.quantity ?? 0),
        averagePrice: Number(p.average_price ?? 0),
        lastPrice: Number(p.last_price ?? 0),
        pnl: Number(p.pnl ?? 0),
        dayBuyQty: Number(p.day_buy_quantity ?? 0),
        dayBuyPrice: Number(p.day_buy_price ?? p.buy_price ?? 0),
        daySellQty: Number(p.day_sell_quantity ?? 0),
        daySellPrice: Number(p.day_sell_price ?? p.sell_price ?? 0),
        realizedPnl: Number(p.realised ?? p.pnl ?? 0),
      }));

    const positions = mappedAll.filter((p) => p.quantity !== 0);

    return { ok: true, positions, dayPositions: mappedAll };
  } catch (err) {
    return {
      ok: false,
      positions: [],
      error: err instanceof Error ? err.message : 'Upstox positions fetch failed.',
    };
  }
}

export async function fetchUpstoxIndexSnapshots(): Promise<{
  ok: boolean;
  nifty50?: number;
  niftyPrevClose?: number;
  indiaVix?: number;
  error?: string;
}> {
  const token = getUpstoxAccessToken();
  if (!token) return { ok: false, error: 'Missing Upstox token.' };

  const keys = ['NSE_INDEX|Nifty 50', 'NSE_INDEX|India VIX'];
  const url = `https://api.upstox.com/v2/market-quote/quotes?instrument_key=${encodeURIComponent(
    keys.join(',')
  )}`;

  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(7000),
    });
    const json = (await resp.json()) as {
      status?: string;
      data?: Record<
        string,
        { last_price?: number; ohlc?: { close?: number } }
      >;
    };
    if (!resp.ok || json.status === 'error' || !json.data) {
      return { ok: false, error: `Upstox index quote HTTP ${resp.status}` };
    }
    const nifty =
      json.data['NSE_INDEX|Nifty 50'] || json.data['NSE_INDEX:Nifty 50'];
    const vix =
      json.data['NSE_INDEX|India VIX'] || json.data['NSE_INDEX:India VIX'];
    return {
      ok: true,
      nifty50: nifty?.last_price ? Number(nifty.last_price) : undefined,
      niftyPrevClose: nifty?.ohlc?.close ? Number(nifty.ohlc.close) : undefined,
      indiaVix: vix?.last_price ? Number(vix.last_price) : undefined,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Index quote lookup failed.',
    };
  }
}

export interface UpstoxOptionCandidate {
  instrumentKey: string;
  tradingSymbol: string;
  optionType: 'CE' | 'PE';
  strikePrice: number;
  lotSize: number;
  ltp: number;
  oi: number;
  delta: number;
  expiry: string;
}

let cachedOptionDate = '';
let cachedNearestExpiry = '';
let cachedOptionMetaMap: Map<string, { tradingSymbol: string; lotSize: number }> = new Map();
let lastOptionChainFetchMs = 0;

export async function fetchAffordableNiftyOption(
  optionType: 'CE' | 'PE',
  maxBudgetInr: number
): Promise<{ ok: boolean; option?: UpstoxOptionCandidate; error?: string }> {
  const token = getUpstoxAccessToken();
  if (!token) return { ok: false, error: 'Missing Upstox token.' };

  const todayIso = new Date().toISOString().slice(0, 10);
  const nowMs = Date.now();
  // Throttle option-chain polling to max once per 10 seconds to save RAM & API quota
  if (nowMs - lastOptionChainFetchMs < 10_000) {
    return { ok: false, error: 'Option chain cooldown active (10s).' };
  }
  lastOptionChainFetchMs = nowMs;

  try {
    // Cache the heavy /v2/option/contract JSON once per day to keep RAM under 512 MB
    if (cachedOptionDate !== todayIso || !cachedNearestExpiry || cachedOptionMetaMap.size === 0) {
      const contractUrl = `https://api.upstox.com/v2/option/contract?instrument_key=${encodeURIComponent(
        'NSE_INDEX|Nifty 50'
      )}`;
      const cResp = await fetch(contractUrl, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      const cJson = (await cResp.json()) as {
        status?: string;
        data?: Array<{
          instrument_key?: string;
          trading_symbol?: string;
          expiry?: string;
          strike_price?: number;
          instrument_type?: string;
          lot_size?: number;
        }>;
      };

      if (!cResp.ok || cJson.status === 'error' || !Array.isArray(cJson.data) || cJson.data.length === 0) {
        return { ok: false, error: `Upstox option contracts HTTP ${cResp.status}` };
      }

      const expiries = Array.from(
        new Set(
          cJson.data
            .map((c) => c.expiry)
            .filter((e): e is string => typeof e === 'string' && e >= todayIso)
        )
      ).sort();
      const nearestExpiry = expiries[0];
      if (!nearestExpiry) {
        return { ok: false, error: 'No active upcoming NIFTY expiry found.' };
      }

      const metaMap = new Map<string, { tradingSymbol: string; lotSize: number }>();
      for (const c of cJson.data) {
        if (c.instrument_key && c.trading_symbol && c.expiry === nearestExpiry) {
          metaMap.set(c.instrument_key, {
            tradingSymbol: c.trading_symbol,
            lotSize: Number(c.lot_size ?? 65),
          });
        }
      }
      cachedOptionDate = todayIso;
      cachedNearestExpiry = nearestExpiry;
      cachedOptionMetaMap = metaMap;
    }

    const nearestExpiry = cachedNearestExpiry;
    const contractMap = cachedOptionMetaMap;

    const chainUrl = `https://api.upstox.com/v2/option/chain?instrument_key=${encodeURIComponent(
      'NSE_INDEX|Nifty 50'
    )}&expiry_date=${encodeURIComponent(nearestExpiry)}`;
    const chResp = await fetch(chainUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    const chJson = (await chResp.json()) as {
      status?: string;
      data?: Array<{
        expiry?: string;
        strike_price?: number;
        underlying_spot_price?: number;
        call_options?: {
          instrument_key?: string;
          market_data?: { ltp?: number; oi?: number; volume?: number };
          option_greeks?: { delta?: number };
        };
        put_options?: {
          instrument_key?: string;
          market_data?: { ltp?: number; oi?: number; volume?: number };
          option_greeks?: { delta?: number };
        };
      }>;
    };

    if (!chResp.ok || chJson.status === 'error' || !Array.isArray(chJson.data)) {
      return { ok: false, error: `Upstox option chain HTTP ${chResp.status}` };
    }

    const candidates: UpstoxOptionCandidate[] = [];
    for (const row of chJson.data) {
      const leg = optionType === 'CE' ? row.call_options : row.put_options;
      if (!leg?.instrument_key || !leg.market_data?.ltp) continue;
      const meta = contractMap.get(leg.instrument_key);
      const lotSize = meta?.lotSize ?? 65;
      const ltp = Number(leg.market_data.ltp);
      const lotCost = ltp * lotSize;
      // Fit comfortably inside ₹10K capital & avoid ultra-cheap lottery decay (< ₹25)
      if (ltp >= 25 && lotCost <= maxBudgetInr && Number(leg.market_data.oi ?? 0) > 10_000) {
        candidates.push({
          instrumentKey: leg.instrument_key,
          tradingSymbol:
            meta?.tradingSymbol || `NIFTY ${row.strike_price ?? ''} ${optionType}`,
          optionType,
          strikePrice: Number(row.strike_price ?? 0),
          lotSize,
          ltp,
          oi: Number(leg.market_data.oi ?? 0),
          delta: Math.abs(Number(leg.option_greeks?.delta ?? 0.35)),
          expiry: nearestExpiry,
        });
      }
    }

    if (candidates.length === 0) {
      return {
        ok: false,
        error: `No liquid NIFTY ${optionType} contract fits inside ₹${maxBudgetInr.toFixed(0)} budget.`,
      };
    }

    // Pick highest delta (~ATM/closest strike) that fits inside capital
    candidates.sort((a, b) => b.delta - a.delta || b.oi - a.oi);
    return { ok: true, option: candidates[0] };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Upstox option chain lookup failed.',
    };
  }
}

export async function fetchUpstoxSingleQuote(
  instrumentKey: string
): Promise<{ ok: boolean; ltp?: number; error?: string }> {
  const token = getUpstoxAccessToken();
  if (!token) return { ok: false, error: 'Missing Upstox token.' };
  const url = `https://api.upstox.com/v2/market-quote/quotes?instrument_key=${encodeURIComponent(
    instrumentKey
  )}`;
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(7000),
    });
    const json = (await resp.json()) as {
      status?: string;
      data?: Record<string, { last_price?: number }>;
    };
    if (!resp.ok || json.status === 'error' || !json.data) {
      return { ok: false, error: `Quote HTTP ${resp.status}` };
    }
    const first = Object.values(json.data)[0];
    if (!first?.last_price) return { ok: false, error: 'Missing LTP in option quote.' };
    return { ok: true, ltp: Number(first.last_price) };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Single quote lookup failed.',
    };
  }
}


