import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import type { GuardrailsConfig, StrategyId } from './src/shared/types.ts';
import { runUpstoxHistoricalBacktest } from './src/server/backtester.ts';
import { TradingEngine } from './src/server/strategyEngine.ts';
import {
  authorizeUpstoxWebsocket,
  exchangeUpstoxAuthCode,
  requestUpstoxAccessTokenViaNotifier,
  saveUpstoxAccessToken,
} from './src/server/upstoxClient.ts';
import { getAlertChannelStatus, sendTelegramAlert } from './src/server/telegramBot.ts';

process.on('unhandledRejection', (err) => {
  console.error('[ArthaQuant Self-Heal] Caught unhandledRejection:', err);
});
process.on('uncaughtException', (err) => {
  console.error('[ArthaQuant Self-Heal] Caught uncaughtException:', err);
});

const PORT = Number(process.env.PORT || 3000);

async function startServer(): Promise<void> {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json({ limit: '1mb' }));

  const engine = new TradingEngine();

  app.get('/api/state', (_req, res) => {
    res.json(engine.getSnapshot());
  });

  app.get('/api/health', (_req, res) => {
    res.json(engine.getSystemHealth());
  });

  app.get('/api/alerts/status', (_req, res) => {
    res.json({ channels: getAlertChannelStatus() });
  });

  app.post('/api/alerts/test', async (req, res) => {
    const snap = engine.getSnapshot();
    const health = engine.getSystemHealth();
    const ntfyTopicOverride =
      typeof req.body?.ntfyTopic === 'string' && req.body.ntfyTopic.trim()
        ? req.body.ntfyTopic.trim()
        : undefined;
    const msg = `ARTHA QUANT LIVE CHECK [${snap.status}]\nBalance: ${
      snap.upstoxLiveBalanceInr !== null
        ? `₹${snap.upstoxLiveBalanceInr.toLocaleString('en-IN')}`
        : 'Syncing / Token Required'
    }\nServer: ${health.rssMb} MB RSS | CPU Load: ${health.cpuLoadPct}% (${health.cpuCount} vCPU)\nCommands: /status /balance /health /login /code /pause /resume /kill`;
    const sent = await sendTelegramAlert(msg, { ntfyTopicOverride });
    if (!sent) {
      res.status(400).json({
        ok: false,
        channels: getAlertChannelStatus(),
        error: 'Set NTFY_TOPIC in server .env / Secrets to receive mobile push notifications.',
      });
      return;
    }
    res.json({ ok: true, channels: getAlertChannelStatus(), health });
  });

  app.post('/api/telegram/test', async (req, res) => {
    const snap = engine.getSnapshot();
    const health = engine.getSystemHealth();
    const ntfyTopicOverride =
      typeof req.body?.ntfyTopic === 'string' && req.body.ntfyTopic.trim()
        ? req.body.ntfyTopic.trim()
        : undefined;
    const sent = await sendTelegramAlert(
      `ARTHA QUANT LIVE CHECK [${snap.status}]\nBalance: ${
        snap.upstoxLiveBalanceInr !== null
          ? `₹${snap.upstoxLiveBalanceInr.toLocaleString('en-IN')}`
          : 'Syncing / Token Required'
      }\nServer: ${health.rssMb} MB RSS | CPU Load: ${health.cpuLoadPct}% (${health.cpuCount} vCPU)\nCommands: /status /balance /health /login /code /pause /resume /kill`,
      { ntfyTopicOverride }
    );
    if (!sent) {
      res.status(400).json({
        ok: false,
        channels: getAlertChannelStatus(),
        error: 'Set NTFY_TOPIC in server .env / Secrets to receive mobile push notifications.',
      });
      return;
    }
    res.json({ ok: true, channels: getAlertChannelStatus(), health });
  });

  app.post('/api/engine/resume', (_req, res) => {
    engine.resumeAutonomous();
    res.json(engine.getSnapshot());
  });

  app.post('/api/engine/pause', (_req, res) => {
    engine.pauseAutonomous();
    res.json(engine.getSnapshot());
  });

  app.post('/api/engine/kill-switch', async (req, res) => {
    const reason =
      typeof req.body?.reason === 'string' && req.body.reason.trim()
        ? req.body.reason.trim()
        : 'Operator activated Emergency Kill-Switch & flattened all live Upstox positions.';
    await engine.killSwitch(reason);
    res.json(engine.getSnapshot());
  });

  app.post('/api/engine/reset', (req, res) => {
    const cap =
      typeof req.body?.allocatedCapitalInr === 'number'
        ? req.body.allocatedCapitalInr
        : undefined;
    engine.resetEngine(cap);
    res.json(engine.getSnapshot());
  });

  app.put('/api/guardrails', (req, res) => {
    engine.updateGuardrails((req.body || {}) as Partial<GuardrailsConfig>);
    res.json(engine.getSnapshot());
  });

  app.put('/api/strategies/:id', (req, res) => {
    const id = req.params.id as StrategyId;
    engine.updateStrategy(id, req.body || {});
    res.json(engine.getSnapshot());
  });

  app.post('/api/ai/evaluate', async (_req, res) => {
    try {
      const report = await engine.triggerAiSupervisor();
      res.json({ report, state: engine.getSnapshot() });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Gemini AI Supervisor evaluation failed.';
      res.status(500).json({ error: message, state: engine.getSnapshot() });
    }
  });

  app.post('/api/ai/auto-apply', (req, res) => {
    const enabled = Boolean(req.body?.enabled);
    engine.setAiAutoApply(enabled);
    res.json(engine.getSnapshot());
  });

  app.post('/api/backtest', async (req, res) => {
    try {
      const snap = engine.getSnapshot();
      const result = await runUpstoxHistoricalBacktest(
        { days: Number(req.body?.days || 60) },
        snap.guardrails,
        snap.strategies
      );
      res.json(result);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Upstox historical backtest failed.';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/market-data/tick', async (req, res) => {
    const { symbol, ltp, open, high, low, prevClose, vwap, rvol } = req.body || {};
    const result = await engine.ingestExternalTick({
      symbol: String(symbol || ''),
      ltp: Number(ltp),
      open: open !== undefined ? Number(open) : undefined,
      high: high !== undefined ? Number(high) : undefined,
      low: low !== undefined ? Number(low) : undefined,
      prevClose: prevClose !== undefined ? Number(prevClose) : undefined,
      vwap: vwap !== undefined ? Number(vwap) : undefined,
      rvol: rvol !== undefined ? Number(rvol) : undefined,
    });
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json({ ok: true, state: engine.getSnapshot() });
  });

  app.post('/api/system/static-ip', async (_req, res) => {
    const ipInfo = await engine.refreshStaticIp();
    res.json({ staticIp: ipInfo, state: engine.getSnapshot() });
  });

  app.post('/api/upstox/sync-quotes', async (_req, res) => {
    const result = await engine.syncUpstoxAccountAndQuotes();
    if (!result.ok) {
      res.status(400).json({ error: result.error, state: engine.getSnapshot() });
      return;
    }
    res.json({ updatedCount: result.updatedCount, state: engine.getSnapshot() });
  });

  app.get('/api/upstox/funds', async (_req, res) => {
    const result = await engine.checkUpstoxFunds();
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json(result);
  });

  app.get('/api/upstox/ws-authorize', async (_req, res) => {
    const result = await authorizeUpstoxWebsocket();
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json(result);
  });

  app.get('/api/upstox/login', (req, res) => {
    const clientId = process.env.UPSTOX_API_KEY;
    const redirectUri =
      process.env.UPSTOX_REDIRECT_URI ||
      (process.env.APP_URL
        ? `${process.env.APP_URL.replace(/\/$/, '')}/api/upstox/callback`
        : `${req.protocol}://${req.get('host')}/api/upstox/callback`);

    if (!clientId) {
      res
        .status(400)
        .send(
          'UPSTOX_API_KEY is not configured in server .env / Secrets. Add UPSTOX_API_KEY and UPSTOX_API_SECRET to enable 1-tap Upstox login.'
        );
      return;
    }

    const authUrl = `https://api.upstox.com/v2/login/authorization/dialog?response_type=code&client_id=${encodeURIComponent(
      clientId
    )}&redirect_uri=${encodeURIComponent(redirectUri)}`;
    res.redirect(authUrl);
  });

  app.get('/api/upstox/callback', async (req, res) => {
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!code) {
      res.status(400).send('Missing Upstox authorization code in callback.');
      return;
    }

    const fallbackRedirectUri = `${req.protocol}://${req.get('host')}/api/upstox/callback`;
    const tokenRes = await exchangeUpstoxAuthCode(code, fallbackRedirectUri);
    if (!tokenRes.ok) {
      res.status(400).send(`Upstox OAuth token exchange failed: ${tokenRes.error}`);
      return;
    }

    await engine.syncUpstoxAccountAndQuotes();
    engine.resumeAutonomous();
    void sendTelegramAlert('Upstox 24h access token refreshed via OAuth login. Engine armed.');
    res.redirect('/');
  });

  app.post('/api/upstox/request-token', async (_req, res) => {
    const result = await requestUpstoxAccessTokenViaNotifier();
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json(result);
  });

  app.post('/api/upstox/notifier-webhook', async (req, res) => {
    const body = (req.body || {}) as {
      client_id?: string;
      access_token?: string;
      user_id?: string;
      data?: {
        access_token?: string;
        token_type?: string;
      };
    };
    const expectedClientId = process.env.UPSTOX_API_KEY;
    if (expectedClientId && body.client_id && body.client_id !== expectedClientId) {
      res.status(403).json({ error: 'Invalid Upstox client_id.' });
      return;
    }
    const rawToken = body.data?.access_token || body.access_token || '';
    const cleanToken = rawToken.replace(/^Bearer\s+/i, '').trim();
    if (!cleanToken) {
      res.status(400).json({ error: 'Missing access_token in Upstox notifier payload.' });
      return;
    }
    saveUpstoxAccessToken(cleanToken);
    await engine.syncUpstoxAccountAndQuotes();
    engine.resumeAutonomous();
    void sendTelegramAlert('Upstox 24h access token received via WhatsApp/App approval! Live bot armed.');
    res.status(200).json({ ok: true, status: 'token_received' });
  });

  app.post('/api/nse/holidays', async (_req, res) => {
    const calendar = await engine.syncNseCalendar();
    res.json({ calendar, state: engine.getSnapshot() });
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('/{*splat}', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Artha Quant Upstox Live server listening on http://0.0.0.0:${PORT}`);
  });
}

void startServer();
