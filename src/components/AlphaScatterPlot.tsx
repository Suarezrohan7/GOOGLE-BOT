import { useState } from 'react';
import type { MarketTickerSnapshot } from '../shared/types';
import { formatInr, formatSignedPct } from '../utils/format';

interface AlphaScatterPlotProps {
  tickers: MarketTickerSnapshot[];
  vetoedSymbols: string[];
  maxTicketInr: number;
}

export function AlphaScatterPlot({
  tickers,
  vetoedSymbols,
  maxTicketInr,
}: AlphaScatterPlotProps) {
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);

  const width = 760;
  const height = 220;
  const padL = 48;
  const padR = 24;
  const padT = 18;
  const padB = 26;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const xForZ = (z: number) => {
    const clamped = Math.max(-2.5, Math.min(2.5, z));
    return padL + ((clamped + 2.5) / 5) * plotW;
  };

  const yForRvol = (rvol: number) => {
    const clamped = Math.max(0.5, Math.min(3.2, rvol));
    return padT + ((3.2 - clamped) / 2.7) * plotH;
  };

  const activeTicker =
    tickers.find((t) => t.symbol === selectedSymbol) ||
    tickers.find((t) => t.signal !== null) ||
    tickers[0];

  return (
    <div className="w-full">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-2 text-[11px] text-slate-400">
        <div className="flex flex-wrap items-center gap-4">
          <span className="inline-flex items-center gap-1.5 text-emerald-400">
            <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" />
            BUY Signal
          </span>
          <span className="inline-flex items-center gap-1.5 text-rose-400">
            <span className="w-2 h-2 rounded-full bg-rose-500 inline-block" />
            SELL Signal
          </span>
          <span className="inline-flex items-center gap-1.5 text-amber-400">
            <span className="w-2 h-2 rounded-full bg-amber-500 inline-block" />
            Ticket &gt; ₹{Math.round(maxTicketInr)} Cap
          </span>
          <span className="inline-flex items-center gap-1.5 text-slate-400">
            <span className="w-2 h-2 rounded-full bg-slate-500 inline-block" />
            Neutral
          </span>
        </div>

        {activeTicker && (
          <div className="font-mono tabular-nums text-slate-200">
            {activeTicker.symbol} {formatInr(activeTicker.ltp)} ({formatSignedPct(activeTicker.changePct)}) · Z{' '}
            {activeTicker.zScore.toFixed(2)} · RVOL {activeTicker.rvol.toFixed(2)}x · RSI{' '}
            {activeTicker.rsi14.toFixed(1)}
          </div>
        )}
      </div>

      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto select-none">
        {/* Background quadrant grid */}
        {[-2, -1, 0, 1, 2].map((z) => {
          const x = xForZ(z);
          return (
            <g key={z}>
              <line
                x1={x}
                y1={padT}
                x2={x}
                y2={padT + plotH}
                stroke={z === 0 ? '#334155' : '#162032'}
                strokeWidth="1"
                strokeDasharray={z === 0 ? '3 3' : undefined}
              />
              <text
                x={x}
                y={height - 6}
                textAnchor="middle"
                className="fill-slate-500 text-[9px] font-mono"
              >
                Z {z > 0 ? `+${z}` : z}
              </text>
            </g>
          );
        })}

        {[0.8, 1.4, 2.0, 2.6, 3.0].map((rv) => {
          const y = yForRvol(rv);
          return (
            <g key={rv}>
              <line
                x1={padL}
                y1={y}
                x2={width - padR}
                y2={y}
                stroke={rv === 1.4 ? '#334155' : '#162032'}
                strokeWidth="1"
                strokeDasharray={rv === 1.4 ? '3 3' : undefined}
              />
              <text
                x={padL - 8}
                y={y + 3}
                textAnchor="end"
                className="fill-slate-500 text-[9px] font-mono"
              >
                {rv.toFixed(1)}x
              </text>
            </g>
          );
        })}

        {/* Constellation links for correlated banking/IT pairs */}
        {[
          ['HDFCBANK', 'ICICIBANK'],
          ['INFY', 'TCS'],
          ['SBIN', 'AXISBANK'],
        ].map(([aSym, bSym]) => {
          const a = tickers.find((t) => t.symbol === aSym);
          const b = tickers.find((t) => t.symbol === bSym);
          if (!a || !b) return null;
          return (
            <line
              key={`${aSym}-${bSym}`}
              x1={xForZ(a.zScore)}
              y1={yForRvol(a.rvol)}
              x2={xForZ(b.zScore)}
              y2={yForRvol(b.rvol)}
              stroke="#1e293b"
              strokeWidth="1"
              strokeDasharray="2 3"
            />
          );
        })}

        {/* Stock Nodes */}
        {tickers.map((t) => {
          const cx = xForZ(t.zScore);
          const cy = yForRvol(t.rvol);
          const ticketBlocked = t.ltp > maxTicketInr;
          const isVetoed = vetoedSymbols.includes(t.symbol);
          const isSelected = activeTicker?.symbol === t.symbol;

          let fill = '#475569';
          let stroke = '#94a3b8';
          if (isVetoed) {
            fill = '#7f1d1d';
            stroke = '#f87171';
          } else if (ticketBlocked) {
            fill = '#78350f';
            stroke = '#fbbf24';
          } else if (t.signalSide === 'BUY') {
            fill = '#065f46';
            stroke = '#34d399';
          } else if (t.signalSide === 'SELL') {
            fill = '#7f1d1d';
            stroke = '#fb7185';
          }

          const radius = t.signal ? 8 : 5.5;

          return (
            <g
              key={t.symbol}
              className="cursor-pointer"
              onMouseEnter={() => setSelectedSymbol(t.symbol)}
              onClick={() => setSelectedSymbol(t.symbol)}
            >
              {isSelected && (
                <circle
                  cx={cx}
                  cy={cy}
                  r={radius + 4}
                  fill="none"
                  stroke="#38bdf8"
                  strokeWidth="1"
                />
              )}
              <circle
                cx={cx}
                cy={cy}
                r={radius}
                fill={fill}
                stroke={stroke}
                strokeWidth="1.5"
              />
              <text
                x={cx}
                y={cy - radius - 4}
                textAnchor="middle"
                className="fill-slate-300 text-[9px] font-mono font-medium"
              >
                {t.symbol}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
