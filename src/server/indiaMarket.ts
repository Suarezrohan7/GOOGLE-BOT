import type {
  IndianCostBreakdown,
  MarketSessionInfo,
  NseHolidayItem,
  OrderSide,
  ProductType,
} from '../shared/types.ts';

// Verified 2026 Official NSE Equity Segment Trading Holidays (nseindia.com)
const VERIFIED_2026_NSE_HOLIDAYS: NseHolidayItem[] = [
  { date: '2026-01-26', description: 'Republic Day' },
  { date: '2026-03-03', description: 'Holi' },
  { date: '2026-03-26', description: 'Shri Ram Navami' },
  { date: '2026-03-31', description: 'Shri Mahavir Jayanti' },
  { date: '2026-04-03', description: 'Good Friday' },
  { date: '2026-04-14', description: 'Dr. Baba Saheb Ambedkar Jayanti' },
  { date: '2026-05-01', description: 'Maharashtra Day' },
  { date: '2026-05-28', description: 'Bakri Id' },
  { date: '2026-06-26', description: 'Muharram' },
  { date: '2026-09-14', description: 'Ganesh Chaturthi' },
  { date: '2026-10-02', description: 'Mahatma Gandhi Jayanti' },
  { date: '2026-10-20', description: 'Dussehra' },
  { date: '2026-11-10', description: 'Diwali-Balipratipada' },
  { date: '2026-11-24', description: 'Prakash Gurpurb Sri Guru Nanak Dev' },
  { date: '2026-12-25', description: 'Christmas' },
];

let cachedHolidays: NseHolidayItem[] = VERIFIED_2026_NSE_HOLIDAYS;
let calendarSource: MarketSessionInfo['calendarSource'] = 'verified-2026-nse-schedule';
let lastNseFetchMs = 0;

function parseNseDateToIso(raw: string): string | null {
  const months: Record<string, string> = {
    Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
    Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
  };
  const parts = raw.trim().split('-');
  if (parts.length !== 3) return null;
  const dd = parts[0].padStart(2, '0');
  const mm = months[parts[1]];
  const yyyy = parts[2];
  if (!mm || !yyyy) return null;
  return `${yyyy}-${mm}-${dd}`;
}

export async function refreshNseOfficialHolidays(): Promise<{
  source: MarketSessionInfo['calendarSource'];
  holidays: NseHolidayItem[];
}> {
  const now = Date.now();
  if (now - lastNseFetchMs < 6 * 60 * 60 * 1000 && cachedHolidays.length > 0) {
    return { source: calendarSource, holidays: cachedHolidays };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);

    const homeResp = await fetch('https://www.nseindia.com/', {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: controller.signal,
    });

    const setCookie = homeResp.headers.get('set-cookie') || '';
    const cookieHeader = setCookie
      .split(',')
      .map((c) => c.split(';')[0].trim())
      .filter(Boolean)
      .join('; ');

    const apiResp = await fetch(
      'https://www.nseindia.com/api/holiday-master?type=trading',
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          Accept: 'application/json',
          Referer: 'https://www.nseindia.com/resources/exchange-communication-holidays',
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        },
        signal: controller.signal,
      }
    );
    clearTimeout(timer);

    if (apiResp.ok) {
      const json = (await apiResp.json()) as {
        CM?: Array<{ tradingDate?: string; description?: string }>;
      };
      if (Array.isArray(json.CM) && json.CM.length > 0) {
        const parsed: NseHolidayItem[] = [];
        for (const row of json.CM) {
          const iso = row.tradingDate ? parseNseDateToIso(row.tradingDate) : null;
          if (iso && row.description) {
            parsed.push({ date: iso, description: row.description });
          }
        }
        if (parsed.length > 0) {
          cachedHolidays = parsed;
          calendarSource = 'nseindia.com';
          lastNseFetchMs = now;
          return { source: calendarSource, holidays: cachedHolidays };
        }
      }
    }
  } catch {
    // Graceful fallback to verified 2026 NSE calendar
  }

  lastNseFetchMs = now;
  return { source: calendarSource, holidays: cachedHolidays };
}

/**
 * Strictly computes IST time & NSE market session phase.
 * Live orders are ONLY permitted during LIVE_TRADING (Mon-Fri, 09:15 to 15:15 IST, non-holiday).
 */
export function getIstMarketSession(
  autoSquareoffIst: string,
  nifty50: number,
  niftyChangePct: number,
  indiaVix: number,
  vixThrottleThreshold: number
): MarketSessionInfo {
  const now = new Date();
  const istParts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hour12: false,
  }).formatToParts(now);

  const partMap: Record<string, string> = {};
  for (const p of istParts) {
    partMap[p.type] = p.value;
  }

  const istDateStr = `${partMap.year}-${partMap.month}-${partMap.day}`;
  const weekday = partMap.weekday || 'Mon';
  const isWeekend = weekday === 'Sat' || weekday === 'Sun';
  const hour = Number(partMap.hour || '0');
  const minute = Number(partMap.minute || '0');
  const totalMinutes = hour * 60 + minute;

  const holidayMatch = cachedHolidays.find((h) => h.date === istDateStr) || null;
  const isHoliday = Boolean(holidayMatch);

  const nextHolidays = cachedHolidays
    .filter((h) => h.date >= istDateStr)
    .slice(0, 3);

  const [sqHourStr, sqMinStr] = autoSquareoffIst.split(':');
  const parsedSqH = Number(sqHourStr);
  const parsedSqM = Number(sqMinStr);
  const sqMinutes =
    (Number.isFinite(parsedSqH) ? parsedSqH : 15) * 60 +
    (Number.isFinite(parsedSqM) ? parsedSqM : 5);

  let phase: MarketSessionInfo['phase'] = 'CLOSED';
  if (isHoliday) {
    phase = 'HOLIDAY';
  } else if (!isWeekend) {
    if (totalMinutes >= 9 * 60 && totalMinutes < 9 * 60 + 15) {
      phase = 'PRE_OPEN';
    } else if (totalMinutes >= 9 * 60 + 15 && totalMinutes < sqMinutes) {
      phase = 'LIVE_TRADING';
    } else if (totalMinutes >= sqMinutes && totalMinutes < 15 * 60 + 30) {
      phase = 'SQUAREOFF_WINDOW';
    } else if (totalMinutes >= 15 * 60 + 30 && totalMinutes < 16 * 60) {
      phase = 'POST_CLOSE';
    }
  }

  let regime: MarketSessionInfo['regime'] = 'RANGE_BOUND';
  if (indiaVix >= vixThrottleThreshold * 1.2) {
    regime = 'DEFENSIVE';
  } else if (indiaVix >= vixThrottleThreshold) {
    regime = 'HIGH_VOLATILITY';
  } else if (Math.abs(niftyChangePct) >= 0.65) {
    regime = 'TRENDING_UP';
  }

  // Strictly true ONLY during live NSE equity trading hours (no weekends, no holidays, no pre/post-market)
  const canExecuteOrders = phase === 'LIVE_TRADING';

  return {
    istTimeStr: `${partMap.hour}:${partMap.minute}:${partMap.second} IST`,
    istDateStr,
    phase,
    isWeekend,
    isHoliday,
    holidayName: holidayMatch?.description || null,
    calendarSource,
    nextHolidays,
    canExecuteOrders,
    nifty50: round2(nifty50),
    niftyChangePct: round2(niftyChangePct),
    indiaVix: round2(indiaVix),
    regime,
  };
}

export function calculateIndianTransactionCosts(
  price: number,
  qty: number,
  side: OrderSide,
  productType: ProductType,
  instrumentType: 'EQUITY' | 'OPTION_CE' | 'OPTION_PE' = 'EQUITY'
): IndianCostBreakdown {
  const turnoverInr = price * qty;
  const isOption = instrumentType === 'OPTION_CE' || instrumentType === 'OPTION_PE';

  const brokerageInr = isOption
    ? 20
    : productType === 'MIS'
      ? Math.min(20, turnoverInr * 0.0003)
      : 0;

  const sttInr = isOption
    ? side === 'SELL'
      ? turnoverInr * 0.0015
      : 0
    : productType === 'MIS'
      ? side === 'SELL'
        ? turnoverInr * 0.00025
        : 0
      : turnoverInr * 0.001;

  const exchangeTxnInr = isOption ? turnoverInr * 0.0003503 : turnoverInr * 0.0000297;
  const sebiFeeInr = turnoverInr * 0.000001;
  const ipftInr = isOption ? turnoverInr * 0.000005 : turnoverInr * 0.000001;

  const stampDutyInr =
    side === 'BUY'
      ? isOption
        ? turnoverInr * 0.00003
        : productType === 'MIS'
          ? turnoverInr * 0.00003
          : turnoverInr * 0.00015
      : 0;

  const gstInr = (brokerageInr + exchangeTxnInr + sebiFeeInr + ipftInr) * 0.18;

  const totalChargesInr =
    brokerageInr +
    sttInr +
    exchangeTxnInr +
    sebiFeeInr +
    ipftInr +
    stampDutyInr +
    gstInr;

  return {
    turnoverInr: round2(turnoverInr),
    brokerageInr: round2(brokerageInr),
    sttInr: round2(sttInr),
    exchangeTxnInr: round2(exchangeTxnInr),
    sebiFeeInr: round2(sebiFeeInr),
    stampDutyInr: round2(stampDutyInr),
    ipftInr: round2(ipftInr),
    gstInr: round2(gstInr),
    totalChargesInr: round2(totalChargesInr),
  };
}

export function round2(val: number): number {
  return Math.round(val * 100) / 100;
}
