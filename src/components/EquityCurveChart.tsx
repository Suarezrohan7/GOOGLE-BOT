import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { EquityPoint, TradeRecord } from '../shared/types';
import { formatInr, formatSignedInr } from '../utils/format';

interface EquityCurveChartProps {
  points: EquityPoint[];
  trades?: TradeRecord[];
  height?: number;
}

interface ChartDatum {
  label: string;
  equityInr: number;
  survivalFloorInr: number;
  drawdownPct: number;
  dailyPnlInr: number;
}

export function EquityCurveChart({ points, trades = [], height = 225 }: EquityCurveChartProps) {
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

  const startEquity = points[0].equityInr;
  const latestPoint = points[points.length - 1];
  const isPositive = latestPoint.equityInr >= startEquity;
  const strokeColor = isPositive ? '#22c55e' : '#ef4444';

  // Build Recharts series enriched with realized cumulative daily PnL from trade history
  const pnlByDay = new Map<string, number>();
  for (const tr of trades) {
    const dayKey = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      month: 'short',
      day: '2-digit',
    }).format(new Date(tr.closedAt));
    pnlByDay.set(dayKey, (pnlByDay.get(dayKey) ?? 0) + tr.netPnlInr);
  }

  const data: ChartDatum[] = points.map((p) => ({
    label: p.label,
    equityInr: Number(p.equityInr.toFixed(2)),
    survivalFloorInr: Number(p.survivalFloorInr.toFixed(2)),
    drawdownPct: Number(p.drawdownPct.toFixed(2)),
    dailyPnlInr: Number((p.equityInr - startEquity).toFixed(2)),
  }));

  const allValues = data.flatMap((d) => [d.equityInr, d.survivalFloorInr]);
  const rawMin = Math.min(...allValues);
  const rawMax = Math.max(...allValues);
  const span = Math.max(150, rawMax - rawMin);
  const domainMin = Math.max(0, Math.floor(rawMin - span * 0.14));
  const domainMax = Math.ceil(rawMax + span * 0.14);

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
            Daily Equity ({latestPoint.label})
          </span>
          <span className="inline-flex items-center gap-1.5 text-rose-400 font-medium">
            <span className="inline-block w-3 h-0.5 border-t border-dashed border-rose-500" />
            Survival Floor (25% DD)
          </span>
        </div>
        <div className="font-mono tabular-nums flex items-center gap-2.5 text-slate-300">
          <span>Eq {formatInr(latestPoint.equityInr)}</span>
          <span aria-hidden="true" className="text-slate-600">
            ·
          </span>
          <span className={isPositive ? 'text-emerald-400' : 'text-rose-400'}>
            {formatSignedInr(latestPoint.equityInr - startEquity)}
          </span>
          <span aria-hidden="true" className="text-slate-600">
            ·
          </span>
          <span>DD {latestPoint.drawdownPct.toFixed(2)}%</span>
        </div>
      </div>

      <div style={{ width: '100%', height }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 8, right: 12, left: 4, bottom: 2 }}>
            <defs>
              <linearGradient id="arthaEquityFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={strokeColor} stopOpacity={0.28} />
                <stop offset="95%" stopColor={strokeColor} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="label"
              stroke="#64748b"
              tick={{ fill: '#94a3b8', fontSize: 10 }}
              tickLine={false}
              axisLine={{ stroke: '#1e293b' }}
              minTickGap={24}
            />
            <YAxis
              domain={[domainMin, domainMax]}
              stroke="#64748b"
              tick={{ fill: '#94a3b8', fontSize: 10 }}
              tickLine={false}
              axisLine={false}
              width={62}
              tickFormatter={(v: number) => formatInr(v, true)}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: '#070B12',
                border: '1px solid #334155',
                borderRadius: '6px',
                fontSize: '11px',
                color: '#e2e8f0',
              }}
              formatter={(value, name) => {
                const numericVal = typeof value === 'number' ? value : Number(value ?? 0);
                if (name === 'equityInr') return [formatInr(numericVal), 'Equity'];
                if (name === 'survivalFloorInr') return [formatInr(numericVal), 'Survival Floor'];
                return [formatInr(numericVal), String(name ?? '')];
              }}
              labelFormatter={(lbl) => `IST ${lbl}`}
            />
            {latestPoint.survivalFloorInr > 0 && (
              <ReferenceLine
                y={latestPoint.survivalFloorInr}
                stroke="#ef4444"
                strokeDasharray="4 4"
                strokeWidth={1.3}
              />
            )}
            <Area
              type="monotone"
              dataKey="equityInr"
              stroke={strokeColor}
              strokeWidth={2.2}
              fill="url(#arthaEquityFill)"
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
