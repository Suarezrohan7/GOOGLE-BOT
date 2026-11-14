import { useState } from 'react';
import type { EquityPoint } from '../shared/types';
import { formatInr } from '../utils/format';

interface EquityCurveChartProps {
  points: EquityPoint[];
  height?: number;
}

export function EquityCurveChart({ points, height = 220 }: EquityCurveChartProps) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (!points || points.length === 0) {
    return (
      <div
        className="flex items-center justify-center border border-slate-800 bg-[#090E17] rounded text-xs text-slate-400"
        style={{ height }}
      >
        No equity samples recorded yet.
      </div>
    );
  }

  const width = 760;
  const padLeft = 72;
  const padRight = 18;
  const padTop = 16;
  const padBottom = 24;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const allValues = points.flatMap((p) => [p.equityInr, p.survivalFloorInr]);
  const rawMin = Math.min(...allValues);
  const rawMax = Math.max(...allValues);
  const span = Math.max(150, rawMax - rawMin);
  const minY = rawMin - span * 0.14;
  const maxY = rawMax + span * 0.14;

  const xFor = (i: number) =>
    points.length === 1
      ? padLeft + plotW / 2
      : padLeft + (i / (points.length - 1)) * plotW;

  const yFor = (val: number) =>
    padTop + ((maxY - val) / Math.max(1, maxY - minY)) * plotH;

  const equityPath = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i).toFixed(1)} ${yFor(p.equityInr).toFixed(1)}`)
    .join(' ');

  const floorPath = points
    .map(
      (p, i) =>
        `${i === 0 ? 'M' : 'L'} ${xFor(i).toFixed(1)} ${yFor(p.survivalFloorInr).toFixed(1)}`
    )
    .join(' ');

  const areaPath =
    points.length > 1
      ? `${equityPath} L ${xFor(points.length - 1).toFixed(1)} ${(padTop + plotH).toFixed(
          1
        )} L ${xFor(0).toFixed(1)} ${(padTop + plotH).toFixed(1)} Z`
      : '';

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => minY + t * (maxY - minY));
  const activeIdx = hoverIdx !== null && points[hoverIdx] ? hoverIdx : points.length - 1;
  const activePoint = points[activeIdx];
  const latestEquity = points[points.length - 1].equityInr;
  const startEquity = points[0].equityInr;
  const isPositive = latestEquity >= startEquity;
  const strokeColor = isPositive ? '#22c55e' : '#ef4444';

  return (
    <div className="w-full">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-2 text-[11px] text-slate-400">
        <div className="flex items-center gap-4">
          <span className="inline-flex items-center gap-1.5 font-medium text-slate-200">
            <span
              className={`inline-block w-3 h-0.5 ${
                isPositive ? 'bg-emerald-500' : 'bg-rose-500'
              }`}
            />
            Net Equity ({activePoint.label})
          </span>
          <span className="inline-flex items-center gap-1.5 text-rose-400 font-medium">
            <span className="inline-block w-3 h-0.5 border-t border-dashed border-rose-500" />
            Survival Floor
          </span>
        </div>
        <div className="font-mono tabular-nums flex items-center gap-2.5 text-slate-300">
          <span>Eq {formatInr(activePoint.equityInr)}</span>
          <span aria-hidden="true" className="text-slate-600">·</span>
          <span className="text-rose-400">Floor {formatInr(activePoint.survivalFloorInr)}</span>
          <span aria-hidden="true" className="text-slate-600">·</span>
          <span>DD {activePoint.drawdownPct.toFixed(2)}%</span>
        </div>
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full h-auto select-none overflow-visible"
        onMouseLeave={() => setHoverIdx(null)}
      >
        <defs>
          <linearGradient id="eqFillDark" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={strokeColor} stopOpacity="0.22" />
            <stop offset="100%" stopColor={strokeColor} stopOpacity="0.01" />
          </linearGradient>
        </defs>

        {yTicks.map((val, idx) => {
          const y = yFor(val);
          return (
            <g key={idx}>
              <line
                x1={padLeft}
                y1={y}
                x2={width - padRight}
                y2={y}
                stroke="#1e293b"
                strokeWidth="1"
              />
              <text
                x={padLeft - 8}
                y={y + 4}
                textAnchor="end"
                className="fill-slate-400 text-[10px] font-mono"
              >
                {formatInr(val, true)}
              </text>
            </g>
          );
        })}

        {areaPath && <path d={areaPath} fill="url(#eqFillDark)" />}

        <path
          d={floorPath}
          fill="none"
          stroke="#ef4444"
          strokeWidth="1.4"
          strokeDasharray="4 4"
        />

        <path
          d={equityPath}
          fill="none"
          stroke={strokeColor}
          strokeWidth="2.2"
          strokeLinejoin="round"
        />

        {points.map((p, i) => {
          const cx = xFor(i);
          const cy = yFor(p.equityInr);
          return (
            <g key={i}>
              <rect
                x={cx - plotW / Math.max(10, points.length * 2)}
                y={padTop}
                width={plotW / Math.max(5, points.length)}
                height={plotH}
                fill="transparent"
                onMouseEnter={() => setHoverIdx(i)}
              />
              {i === activeIdx && (
                <>
                  <line
                    x1={cx}
                    y1={padTop}
                    x2={cx}
                    y2={padTop + plotH}
                    stroke="#475569"
                    strokeWidth="1"
                    strokeDasharray="2 2"
                  />
                  <circle
                    cx={cx}
                    cy={cy}
                    r="4"
                    fill="#070B12"
                    stroke={strokeColor}
                    strokeWidth="2"
                  />
                </>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
