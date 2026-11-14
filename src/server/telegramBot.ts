/**
 * Lightweight Phone Notifier & 2-Way Command Poller over ntfy.sh (zero external dependencies).
 * Configured via server-side environment variable: NTFY_TOPIC (uses https://ntfy.sh automatically).
 */

let ntfySinceEpochSec = Math.floor(Date.now() / 1000) - 5;
const seenNtfyIds = new Set<string>();
const NTFY_BASE_URL = 'https://ntfy.sh';

export interface AlertChannelStatus {
  ntfy: boolean;
}

export function getAlertChannelStatus(): AlertChannelStatus {
  return {
    ntfy: Boolean(process.env.NTFY_TOPIC?.trim()),
  };
}

export function isTelegramConfigured(): boolean {
  return Boolean(process.env.NTFY_TOPIC?.trim());
}

function inferNtfyMeta(message: string): { title: string; priority: string; tags: string } {
  const upper = message.toUpperCase();
  if (upper.includes('KILL-SWITCH') || upper.includes('DEADMAN') || upper.includes('HALT')) {
    return { title: 'Artha Quant CRITICAL', priority: '5', tags: 'rotating_light' };
  }
  if (upper.includes('EXPIRED') || upper.includes('APPROVAL') || upper.includes('REQUIRED')) {
    return { title: 'Artha Quant Login', priority: '4', tags: 'key' };
  }
  if (upper.includes('BUY EXECUTED') || upper.includes('PROFIT') || upper.includes('TARGET')) {
    return { title: 'Artha Quant Trade', priority: '4', tags: 'chart_with_upwards_trend' };
  }
  if (upper.includes('SELL EXECUTED') || upper.includes('SQUAREOFF') || upper.includes('STOP')) {
    return { title: 'Artha Quant Exit', priority: '4', tags: 'bell' };
  }
  return { title: 'Artha Quant', priority: '3', tags: 'moneybag' };
}

export async function sendTelegramAlert(
  message: string,
  options?: { ntfyTopicOverride?: string }
): Promise<boolean> {
  const topic = (options?.ntfyTopicOverride ?? process.env.NTFY_TOPIC ?? '').trim();
  if (!topic) return false;

  const meta = inferNtfyMeta(message);
  try {
    const resp = await fetch(`${NTFY_BASE_URL}/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        Title: meta.title,
        Priority: meta.priority,
        Tags: meta.tags,
      },
      body: message,
      signal: AbortSignal.timeout(6000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

export async function pollTelegramCommands(
  onCommand: (cmd: string, argsText: string) => Promise<string>
): Promise<void> {
  const topic = process.env.NTFY_TOPIC?.trim();
  if (!topic) return;

  try {
    const url = `${NTFY_BASE_URL}/${encodeURIComponent(
      topic
    )}/json?poll=1&since=${ntfySinceEpochSec}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return;
    const rawBody = await resp.text();
    if (!rawBody.trim()) return;

    const lines = rawBody.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: { id?: string; time?: number; event?: string; message?: string } | null = null;
      try {
        parsed = JSON.parse(trimmed) as {
          id?: string;
          time?: number;
          event?: string;
          message?: string;
        };
      } catch {
        continue;
      }
      if (!parsed || parsed.event !== 'message' || typeof parsed.message !== 'string') continue;

      if (typeof parsed.time === 'number' && parsed.time > ntfySinceEpochSec) {
        ntfySinceEpochSec = parsed.time;
      }
      const msgId = parsed.id || `${parsed.time}-${parsed.message.slice(0, 16)}`;
      if (seenNtfyIds.has(msgId)) continue;
      seenNtfyIds.add(msgId);
      if (seenNtfyIds.size > 200) {
        const first = seenNtfyIds.values().next().value;
        if (first) seenNtfyIds.delete(first);
      }

      const rawText = parsed.message.trim();
      if (!rawText.startsWith('/')) continue;

      const spaceIdx = rawText.search(/\s/);
      const cmd = (spaceIdx === -1 ? rawText : rawText.slice(0, spaceIdx)).toLowerCase();
      const argsText = spaceIdx === -1 ? '' : rawText.slice(spaceIdx + 1).trim();

      const reply = await onCommand(cmd, argsText);
      if (reply) {
        const safeReply = reply.startsWith('/') ? `ARTHA QUANT:\n${reply}` : reply;
        await sendTelegramAlert(safeReply);
      }
    }
  } catch {
    // Non-fatal; never interrupt trading loop
  }
}
