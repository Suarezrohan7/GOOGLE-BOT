import type {
  BrokerStatusInfo,
  OrderSide,
  ProductType,
} from '../shared/types.ts';
import { calculateIndianTransactionCosts, round2 } from './indiaMarket.ts';
import { getUpstoxAccessToken, resolveUpstoxInstrumentKey } from './upstoxClient.ts';

export interface BrokerOrderRequest {
  symbol: string;
  instrumentToken?: string;
  instrumentType?: 'EQUITY' | 'OPTION_CE' | 'OPTION_PE';
  exchange: 'NSE';
  side: OrderSide;
  qty: number;
  referencePrice: number;
  productType: ProductType;
  urgentExit?: boolean;
}

export interface BrokerOrderResponse {
  orderId: string;
  executedPrice: number;
  qty: number;
  chargesInr: number;
  status: 'COMPLETE' | 'REJECTED';
  message: string;
}

function roundToNseTick(price: number): number {
  return Math.round(price * 20) / 20;
}

export function getBrokerStatuses(): BrokerStatusInfo[] {
  const hasUpstox = Boolean(getUpstoxAccessToken());

  return [
    {
      id: 'upstox',
      label: 'Upstox API v2 / HFT (Live Money)',
      configured: hasUpstox,
      mode: 'live',
      missingEnvVars: [...(!hasUpstox ? ['UPSTOX_ACCESS_TOKEN'] : [])],
      notes:
        'Real-money Long-Only NSE Equity execution via api-hft.upstox.com/v2/order/place using official NSE_EQ|<ISIN> tokens.',
    },
  ];
}

export async function executeLiveUpstoxOrder(
  req: BrokerOrderRequest
): Promise<BrokerOrderResponse> {
  const upstoxToken = getUpstoxAccessToken();
  if (!upstoxToken) {
    return {
      orderId: `ERR-UPSTOX-${Date.now()}`,
      executedPrice: req.referencePrice,
      qty: 0,
      chargesInr: 0,
      status: 'REJECTED',
      message: 'UPSTOX_ACCESS_TOKEN is not configured in server environment.',
    };
  }

  const instrumentToken = req.instrumentToken || resolveUpstoxInstrumentKey(req.symbol);
  const useMarketOrder = Boolean(req.urgentExit);
  const limitPrice =
    req.side === 'BUY'
      ? roundToNseTick(req.referencePrice * 1.001)
      : roundToNseTick(req.referencePrice * 0.999);

  try {
    const resp = await fetch('https://api-hft.upstox.com/v2/order/place', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${upstoxToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        quantity: req.qty,
        product: req.productType === 'MIS' ? 'I' : 'D',
        validity: 'DAY',
        price: useMarketOrder ? 0 : limitPrice,
        instrument_token: instrumentToken,
        order_type: useMarketOrder ? 'MARKET' : 'LIMIT',
        transaction_type: req.side,
        disclosed_quantity: 0,
        trigger_price: 0,
        is_amo: false,
      }),
    });

    const json = (await resp.json()) as {
      status?: string;
      data?: { order_id?: string };
      errors?: Array<{ message?: string }>;
      message?: string;
    };

    if (!resp.ok || json.status === 'error' || !json.data?.order_id) {
      return {
        orderId: `ERR-UPSTOX-${Date.now()}`,
        executedPrice: req.referencePrice,
        qty: 0,
        chargesInr: 0,
        status: 'REJECTED',
        message: json.errors?.[0]?.message || json.message || `Upstox HTTP ${resp.status}`,
      };
    }

    const orderId = json.data.order_id;
    let executedPrice = round2(req.referencePrice);
    let filledQty = req.qty;

    // Poll Upstox order details briefly to verify fill price & catch exchange rejections
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, 400));
        }
        const detailResp = await fetch(
          `https://api.upstox.com/v2/order/details?order_id=${encodeURIComponent(orderId)}`,
          {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${upstoxToken}`,
              Accept: 'application/json',
            },
          }
        );
        if (detailResp.ok) {
          const detailJson = (await detailResp.json()) as {
            data?: {
              average_price?: number;
              status?: string;
              filled_quantity?: number;
              status_message?: string;
            };
          };
          const ordStatus = String(detailJson.data?.status || '').toLowerCase();
          if (ordStatus === 'rejected' || ordStatus === 'cancelled') {
            return {
              orderId,
              executedPrice: req.referencePrice,
              qty: 0,
              chargesInr: 0,
              status: 'REJECTED',
              message:
                detailJson.data?.status_message || `Upstox order ${orderId} ${ordStatus}.`,
            };
          }
          if (detailJson.data?.average_price && detailJson.data.average_price > 0) {
            executedPrice = round2(detailJson.data.average_price);
          }
          if (detailJson.data?.filled_quantity && detailJson.data.filled_quantity > 0) {
            filledQty = Number(detailJson.data.filled_quantity);
          }
          if (ordStatus === 'complete') {
            break;
          }
        }
      } catch {
        // Keep optimistic check if transient network glitch on status poll
      }
    }

    const costs = calculateIndianTransactionCosts(
      executedPrice,
      filledQty,
      req.side,
      req.productType,
      req.instrumentType || 'EQUITY'
    );

    return {
      orderId,
      executedPrice,
      qty: filledQty,
      chargesInr: costs.totalChargesInr,
      status: 'COMPLETE',
      message: `Live Upstox ${useMarketOrder ? 'MARKET' : 'LIMIT'} order ${orderId} (${instrumentToken}) executed.`,
    };
  } catch (err) {
    return {
      orderId: `ERR-UPSTOX-${Date.now()}`,
      executedPrice: req.referencePrice,
      qty: 0,
      chargesInr: 0,
      status: 'REJECTED',
      message: err instanceof Error ? err.message : 'Upstox network execution failure.',
    };
  }
}
