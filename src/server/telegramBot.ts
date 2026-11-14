/**
 * Lightweight Multi-Channel Phone Notifier & 2-Way Command Poller (zero external dependencies).
 * Supports:
 * 1. ntfy.sh (ZERO BotFather / ZERO account / instant iOS & Android push + 2-way /commands)
 * 2. Discord Webhook (DISCORD_WEBHOOK_URL)
 * 3. Telegram Bot (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)
 */

let lastUpdateOffset = 0;
let ntfySinceEpochSec = Math.floor(Date.now() / 1000) - 5;
const seenNtfyIds = new Set<string>();

export interface AlertChannelStatus {
  ntfy: boolean;
  discord: boolean;
  telegram: boolean;
}

export function getAlertChannelStatus(): AlertChannelStatus {
  return {
    ntfy: Boolean(process.env.NTFY_TOPIC?.trim()),
    discord: Boolean(process.env.DISCORD_WEBHOOK_URL?.trim()),
    telegram: Boolean(
      process.env.TELEGRAM_BOT_TOKEN?.trim() && process.env.TELEGRAM_CHAT_ID?.trim()
    ),
  };
}

export function isTelegramConfigured(): boolean {
  const status = getAlertChannelStatus();
  return status.ntfy || status.discord || status.telegram;
}

function getNtfyBaseUrl(): string {
  const raw = (process.env.NTFY_SERVER || 'https://ntfy.sh').trim().replace(/\/$/, '');
  return raw || 'https://ntfy.sh';
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

async function sendNtfyAlert(message: string, topicOverride?: string): Promise<boolean> {
  const topic = (topicOverride ?? process.env.NTFY_TOPIC ?? '').trim();
  if (!topic) return false;

  const meta = inferNtfyMeta(message);
  try {
    const resp = await fetch(`${getNtfyBaseUrl()}/${encodeURIComponent(topic)}`, {
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

async function sendDiscordAlert(message: string): Promise<boolean> {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL?.trim();
  if (!webhookUrl) return false;

  try {
    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: message.slice(0, 1950),
      }),
      signal: AbortSignal.timeout(6000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

async function sendTelegramOnly(message: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) return false;

  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(6000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * Broadcasts alert to all configured mobile channels (ntfy.sh, Discord, Telegram).
 */
export async function sendTelegramAlert(
  message: string,
  options?: { ntfyTopicOverride?: string }
): Promise<boolean> {
  const results = await Promise.all([
    sendNtfyAlert(message, options?.ntfyTopicOverride),
    sendDiscordAlert(message),
    sendTelegramOnly(message),
  ]);
  return results.some(Boolean);
}

async function pollNtfyCommands(
  onCommand: (cmd: string, argsText: string) => Promise<string>
): Promise<void> {
  const topic = process.env.NTFY_TOPIC?.trim();
  if (!topic) return;

  try {
    const url = `${getNtfyBaseUrl()}/${encodeURIComponent(
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
        await sendNtfyAlert(safeReply);
      }
    }
  } catch {
    // Non-fatal; never interrupt trading loop
  }
}

async function pollTelegramOnly(
  onCommand: (cmd: string, argsText: string) => Promise<string>
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const allowedChatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !allowedChatId) return;

  try {
    const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${
      lastUpdateOffset + 1
    }&limit=10&timeout=0`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return;
    const json = (await resp.json()) as {
      ok?: boolean;
      result?: Array<{
        update_id: number;
        message?: { chat?: { id?: number | string }; text?: string };
      }>;
    };
    if (!json.ok || !Array.isArray(json.result)) return;

    for (const upd of json.result) {
      if (upd.update_id > lastUpdateOffset) {
        lastUpdateOffset = upd.update_id;
      }
      const msgChatId = String(upd.message?.chat?.id ?? '');
      const rawText = (upd.message?.text ?? '').trim();
      if (msgChatId !== allowedChatId || !rawText.startsWith('/')) continue;

      const spaceIdx = rawText.search(/\s/);
      const cmd = (spaceIdx === -1 ? rawText : rawText.slice(0, spaceIdx))
        .split('@')[0]
        .toLowerCase();
      const argsText = spaceIdx === -1 ? '' : rawText.slice(spaceIdx + 1).trim();

      const reply = await onCommand(cmd, argsText);
      if (reply) {
        await sendTelegramOnly(reply);
      }
    }
  } catch {
    // Non-fatal; never interrupt trading loop
  }
}

export async function pollTelegramCommands(
  onCommand: (cmd: string, argsText: string) => Promise<string>
): Promise<void> {
  await Promise.all([pollNtfyCommands(onCommand), pollTelegramOnly(onCommand)]);
}
