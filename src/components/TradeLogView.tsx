import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Download } from 'lucide-react';
import type { BotStateSnapshot, TradeRecord } from '../shared/types';
import { formatInr, formatSignedInr, formatTimeShort } from '../utils/format';

interface TradeLogViewProps {
  state: BotStateSnapshot;
}

type SortKey =
  | 'closedAt'
  | 'symbol'
  | 'side'
  | 'qty'
  | 'entryPrice'
  | 'exitPrice'
  | 'chargesInr'
  | 'netPnlInr'
  | 'exitReason';

type SortDir = 'asc' | 'desc';

function formatIstDateTime(iso: string): string {
  try {
    const datePart = new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit',
      month: 'short',
    }).format(new Date(iso));
    return `${datePart} ${formatTimeShort(iso)}`;
  } catch {
    return iso.slice(0, 19).replace('T', ' ');
  }
}

export function TradeLogView({ state }: TradeLogViewProps) {
  const [persistedTrades, setPersistedTrades] = useState<TradeRecord[]>([]);
  const [search, setSearch] = useState('');
  const [outcomeFilter, setOutcomeFilter] = useState<'ALL' | 'WINS' | 'LOSSES'>('ALL');
  const [sortKey, setSortKey] = useState<SortKey>('closedAt');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const resp = await fetch('/api/trades/history?limit=500');
        if (!resp.ok) return;
        const json = (await resp.json()) as { trades?: TradeRecord[] };
        if (active && Array.isArray(json.trades)) {
          setPersistedTrades(json.trades);
        }
      } catch {
        // Fallback to live snapshot trades
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [state.trades.length]);

  const allTrades = useMemo(() => {
    const byId = new Map<string, TradeRecord>();
    for (const tr of persistedTrades) byId.set(tr.id, tr);
    for (const tr of state.trades) byId.set(tr.id, tr);
    return Array.from(byId.values());
  }, [persistedTrades, state.trades]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'symbol' || key === 'side' || key === 'exitReason' ? 'asc' : 'desc');
    }
  };

  const filteredAndSorted = useMemo(() => {
    const q = search.trim().toUpperCase();
    const filtered = allTrades.filter((tr) => {
      if (outcomeFilter === 'WINS' && tr.netPnlInr <= 0) return false;
      if (outcomeFilter === 'LOSSES' && tr.netPnlInr > 0) return false;
      if (!q) return true;
      return (
        tr.symbol.toUpperCase().includes(q) ||
        tr.strategyId.toUpperCase().includes(q) ||
        tr.exitReason.toUpperCase().includes(q)
      );
    });

    const mult = sortDir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      switch (sortKey) {
        case 'closedAt':
          return (new Date(a.closedAt).getTime() - new Date(b.closedAt).getTime()) * mult;
        case 'symbol':
          return a.symbol.localeCompare(b.symbol) * mult;
        case 'side':
          return a.side.localeCompare(b.side) * mult;
        case 'exitReason':
          return a.exitReason.localeCompare(b.exitReason) * mult;
        case 'qty':
          return (a.qty - b.qty) * mult;
        case 'entryPrice':
          return (a.entryPrice - b.entryPrice) * mult;
        case 'exitPrice':
          return (a.exitPrice - b.exitPrice) * mult;
        case 'chargesInr':
          return (a.chargesInr - b.chargesInr) * mult;
        case 'netPnlInr':
          return (a.netPnlInr - b.netPnlInr) * mult;
      }
    });
  }, [allTrades, search, outcomeFilter, sortKey, sortDir]);

  const summary = useMemo(() => {
    const wins = filteredAndSorted.filter((t) => t.netPnlInr > 0);
    const totalGross = filteredAndSorted.reduce((acc, t) => acc + t.grossPnlInr, 0);
    const totalCharges = filteredAndSorted.reduce((acc, t) => acc + t.chargesInr, 0);
    const totalNet = filteredAndSorted.reduce((acc, t) => acc + t.netPnlInr, 0);
    const winRate =
      filteredAndSorted.length > 0 ? (wins.length / filteredAndSorted.length) * 100 : 0;
    return {
      count: filteredAndSorted.length,
      winsCount: wins.length,
      winRate,
      totalGross,
      totalCharges,
      totalNet,
    };
  }, [filteredAndSorted]);

  const exportCsv = () => {
    const header =
      'id,openedAt,closedAt,symbol,side,qty,entryPrice,exitPrice,strategyId,productType,grossPnlInr,chargesInr,netPnlInr,exitReason';
    const lines = filteredAndSorted.map((t) =>
      [
        t.id,
        t.openedAt,
        t.closedAt,
        t.symbol,
        t.side,
        t.qty,
        t.entryPrice,
        t.exitPrice,
        t.strategyId,
        t.productType,
        t.grossPnlInr,
        t.chargesInr,
        t.netPnlInr,
        t.exitReason,
      ].join(',')
    );
    const blob = new Blob([[header, ...lines].join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `artha-trade-log-${state.session.istDateStr}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const renderSortIcon = (key: SortKey) => {
    if (sortKey !== key) {
      return <ArrowUpDown className="w-3 h-3 text-slate-600 shrink-0" />;
    }
    return sortDir === 'asc' ? (
      <ArrowUp className="w-3 h-3 text-emerald-400 shrink-0" />
    ) : (
      <ArrowDown className="w-3 h-3 text-emerald-400 shrink-0" />
    );
  };

  const SortHeader = ({
    columnKey,
    label,
    align = 'left',
  }: {
    columnKey: SortKey;
    label: string;
    align?: 'left' | 'right';
  }) => (
    <th
      className={`py-2.5 px-3 font-medium whitespace-nowrap ${
        align === 'right' ? 'text-right' : 'text-left'
      }`}
    >
      <button
        type="button"
        onClick={() => handleSort(columnKey)}
        className={`inline-flex items-center gap-1 text-slate-400 hover:text-slate-100 transition-colors cursor-pointer ${
          align === 'right' ? 'flex-row-reverse' : ''
        }`}
      >
        <span>{label}</span>
        {renderSortIcon(columnKey)}
      </button>
    </th>
  );

  return (
    <div className="space-y-4">
      {/* KPI Summary Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-[#0C121D] border border-slate-800 rounded p-4">
          <div className="text-[11px] text-slate-400">Executed Trades</div>
          <div className="mt-1.5 text-2xl font-bold font-mono tabular-nums text-slate-100">
            {summary.count}
          </div>
          <div className="mt-1 text-[11px] font-mono text-slate-400">
            Win Rate {summary.winRate.toFixed(1)}% ({summary.winsCount}W /{' '}
            {summary.count - summary.winsCount}L)
          </div>
        </div>

        <div className="bg-[#0C121D] border border-slate-800 rounded p-4">
          <div className="text-[11px] text-slate-400">Net Realized PnL</div>
          <div
            className={`mt-1.5 text-2xl font-bold font-mono tabular-nums ${
              summary.totalNet >= 0 ? 'text-emerald-400' : 'text-rose-400'
            }`}
          >
            {formatSignedInr(summary.totalNet)}
          </div>
          <div className="mt-1 text-[11px] font-mono text-slate-400">
            After all Indian statutory fees
          </div>
        </div>

        <div className="bg-[#0C121D] border border-slate-800 rounded p-4">
          <div className="text-[11px] text-slate-400">Gross Trading PnL</div>
          <div
            className={`mt-1.5 text-2xl font-bold font-mono tabular-nums ${
              summary.totalGross >= 0 ? 'text-emerald-400' : 'text-rose-400'
            }`}
          >
            {formatSignedInr(summary.totalGross)}
          </div>
          <div className="mt-1 text-[11px] font-mono text-slate-400">
            Profit Factor {state.profitFactor.toFixed(2)}
          </div>
        </div>

        <div className="bg-[#0C121D] border border-slate-800 rounded p-4">
          <div className="text-[11px] text-slate-400">Total Brokerage &amp; Taxes</div>
          <div className="mt-1.5 text-2xl font-bold font-mono tabular-nums text-amber-400">
            -{formatInr(summary.totalCharges)}
          </div>
          <div className="mt-1 text-[11px] font-mono text-slate-400">
            STT · Exchange · SEBI · Stamp · GST
          </div>
        </div>
      </div>

      {/* Main Sortable Execution Table */}
      <div className="bg-[#0C121D] border border-slate-800 rounded overflow-hidden">
        <div className="px-4 py-3.5 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">
              Executed Trade Log ({filteredAndSorted.length} of {allTrades.length})
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Click any column header to sort by symbol, side, entry price, exit price, or net PnL.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              placeholder="Search symbol or strategy..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="px-2.5 py-1.5 text-xs font-mono bg-[#070B12] border border-slate-700 rounded text-slate-200 w-44 focus:outline-none focus:border-slate-500"
            />

            <div className="flex items-center gap-1 bg-[#070B12] border border-slate-800 rounded p-1">
              {(['ALL', 'WINS', 'LOSSES'] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setOutcomeFilter(tab)}
                  className={`px-2.5 py-1 text-[11px] font-mono rounded transition-colors cursor-pointer ${
                    outcomeFilter === tab
                      ? 'bg-slate-800 text-slate-100'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {tab}
                </button>
              ))}
            </div>

            {filteredAndSorted.length > 0 && (
              <button
                type="button"
                onClick={exportCsv}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono bg-slate-800 hover:bg-slate-700 text-slate-200 rounded transition-colors cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                Export CSV
              </button>
            )}
          </div>
        </div>

        {filteredAndSorted.length === 0 ? (
          <div className="p-10 text-center text-xs text-slate-400">
            No executed trades match your current filter yet. Completed round-trip Upstox trades
            are stored permanently in <span className="font-mono text-slate-300">data/trade-history.jsonl</span>.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead className="bg-[#090E17] border-b border-slate-800">
                <tr>
                  <SortHeader columnKey="closedAt" label="Closed IST" />
                  <SortHeader columnKey="symbol" label="Symbol" />
                  <SortHeader columnKey="side" label="Side" />
                  <SortHeader columnKey="qty" label="Qty" align="right" />
                  <SortHeader columnKey="entryPrice" label="Entry Price" align="right" />
                  <SortHeader columnKey="exitPrice" label="Exit Price" align="right" />
                  <SortHeader columnKey="chargesInr" label="Charges" align="right" />
                  <SortHeader columnKey="netPnlInr" label="Net PnL" align="right" />
                  <SortHeader columnKey="exitReason" label="Exit Reason" align="right" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {filteredAndSorted.map((tr) => (
                  <tr key={tr.id} className="hover:bg-slate-800/30 transition-colors">
                    <td className="py-2.5 px-3 font-mono tabular-nums text-slate-400 whitespace-nowrap">
                      {formatIstDateTime(tr.closedAt)}
                    </td>
                    <td className="py-2.5 px-3">
                      <div className="font-semibold text-slate-100">{tr.symbol}</div>
                      <div className="text-[10px] font-mono text-slate-400">
                        {tr.strategyId} · {tr.productType}
                      </div>
                    </td>
                    <td
                      className={`py-2.5 px-3 font-mono font-semibold ${
                        tr.side === 'BUY' ? 'text-emerald-400' : 'text-rose-400'
                      }`}
                    >
                      {tr.side}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-200">
                      {tr.qty}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-300">
                      {formatInr(tr.entryPrice)}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-300">
                      {formatInr(tr.exitPrice)}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono tabular-nums text-amber-400">
                      -{formatInr(tr.chargesInr)}
                    </td>
                    <td
                      className={`py-2.5 px-3 text-right font-mono font-semibold tabular-nums ${
                        tr.netPnlInr >= 0 ? 'text-emerald-400' : 'text-rose-400'
                      }`}
                    >
                      <div>{formatSignedInr(tr.netPnlInr)}</div>
                      <div className="text-[10px] font-normal text-slate-500">
                        Gross {formatSignedInr(tr.grossPnlInr)}
                      </div>
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono text-[11px] text-slate-300 whitespace-nowrap">
                      {tr.exitReason}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
