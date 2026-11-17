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

function roundToNseTick(
  price: number,
  instrumentType: 'EQUITY' | 'OPTION_CE' | 'OPTION_PE' = 'EQUITY'
): number {
  if (instrumentType === 'EQUITY' && price >= 1000) {
    return Math.round(price * 10) / 10;
  }
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
  const instType = req.instrumentType || 'EQUITY';
  const useMarketOrder = Boolean(req.urgentExit);
  const limitPrice =
    req.side === 'BUY'
      ? roundToNseTick(req.referencePrice * 1.001, instType)
      : roundToNseTick(req.referencePrice * 0.999, instType);

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
      signal: AbortSignal.timeout(7000),
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
    let filledQty = 0;
    let finalOrdStatus = '';

    // Poll Upstox order details to confirm actual exchange fill before booking position
    const maxAttempts = useMarketOrder ? 5 : 8;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, 400));
        }
        const detailResp = await fetch(
          `https://api-hft.upstox.com/v2/order/details?order_id=${encodeURIComponent(orderId)}`,
          {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${upstoxToken}`,
              Accept: 'application/json',
            },
            signal: AbortSignal.timeout(5000),
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
          finalOrdStatus = String(detailJson.data?.status || '').toLowerCase();
          if (detailJson.data?.average_price && detailJson.data.average_price > 0) {
            executedPrice = round2(detailJson.data.average_price);
          }
          if (detailJson.data?.filled_quantity && detailJson.data.filled_quantity > 0) {
            filledQty = Number(detailJson.data.filled_quantity);
          }
          if (
            (finalOrdStatus === 'rejected' || finalOrdStatus === 'cancelled') &&
            filledQty === 0
          ) {
            return {
              orderId,
              executedPrice: req.referencePrice,
              qty: 0,
              chargesInr: 0,
              status: 'REJECTED',
              message:
                detailJson.data?.status_message || `Upstox order ${orderId} ${finalOrdStatus}.`,
            };
          }
          if (finalOrdStatus === 'complete' && filledQty > 0) {
            break;
          }
        }
      } catch {
        // Retry on transient poll glitch
      }
    }

    // If an opening LIMIT order is still unconfirmed, attempt cancel then RE-CHECK order/details so a late exchange fill is NEVER reported as REJECTED
    if (!useMarketOrder && finalOrdStatus !== 'complete' && filledQty === 0) {
      try {
        await fetch(
          `https://api-hft.upstox.com/v2/order/cancel?order_id=${encodeURIComponent(orderId)}`,
          {
            method: 'DELETE',
            headers: {
              Authorization: `Bearer ${upstoxToken}`,
              Accept: 'application/json',
            },
            signal: AbortSignal.timeout(5000),
          }
        );
        await new Promise((r) => setTimeout(r, 450));
        for (const baseUrl of ['https://api-hft.upstox.com', 'https://api.upstox.com']) {
          const verifyResp = await fetch(
            `${baseUrl}/v2/order/details?order_id=${encodeURIComponent(orderId)}`,
            {
              method: 'GET',
              headers: {
                Authorization: `Bearer ${upstoxToken}`,
                Accept: 'application/json',
              },
              signal: AbortSignal.timeout(5000),
            }
          );
          if (verifyResp.ok) {
            const verifyJson = (await verifyResp.json()) as {
              data?: { average_price?: number; status?: string; filled_quantity?: number };
            };
            const vStatus = String(verifyJson.data?.status || '').toLowerCase();
            const vFilled = Number(verifyJson.data?.filled_quantity ?? 0);
            if (vFilled > 0) {
              filledQty = vFilled;
              finalOrdStatus = vStatus || 'complete';
              if (verifyJson.data?.average_price && verifyJson.data.average_price > 0) {
                executedPrice = round2(verifyJson.data.average_price);
              }
              break;
            }
          }
        }
      } catch {
        // Best-effort cancel & verify
      }

      if (filledQty === 0) {
        return {
          orderId,
          executedPrice: req.referencePrice,
          qty: 0,
          chargesInr: 0,
          status: 'REJECTED',
          message: `Entry limit order ${orderId} remained ${finalOrdStatus || 'open'} after collar window; auto-cancelled safely.`,
        };
      }
    }

    if (filledQty <= 0) {
      filledQty = req.qty;
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
