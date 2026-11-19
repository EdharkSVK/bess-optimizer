import { useState } from 'react';
import { Download } from 'lucide-react';
import Papa from 'papaparse';
import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { download } from '../lib/exports';
import { action, field, money, panel, secondary } from '../lib/solarUi';
import type { BtmEarnings } from '../lib/solar';

interface Props {
  earnings: BtmEarnings;
  annualMedian: number;
  label: string;
}

const medianColor = '#5eead4';
const rangeColor = '#94a3b8';
const ticks = { fill: '#94a3b8', fontSize: 11 };
const axisCurrency = new Intl.NumberFormat('en-IE', {
  style: 'currency', currency: 'EUR', notation: 'compact', maximumFractionDigits: 1,
});
const monthName = new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: 'UTC' });
const dayName = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

function formatPeriod(period: string, format: Intl.DateTimeFormat) {
  return format.format(new Date(`2000-${period}T00:00:00Z`));
}

export default function BtmEarningsChart({ earnings, annualMedian, label }: Props) {
  const [view, setView] = useState<'daily' | 'yearly'>('daily');
  const [month, setMonth] = useState('all');
  const daily = view === 'daily';
  const dailyRows = month === 'all' ? earnings.daily : earnings.daily.filter(row => row.date.startsWith(`${month}-`));
  const monthKeys = earnings.daily.filter(row => row.date.endsWith('-01')).map(row => row.date);
  const rows = (daily
    ? dailyRows.map(row => ({ ...row, period: row.date }))
    : earnings.yearly.map(row => ({ ...row, period: String(row.year) })))
    .map(row => ({ ...row, range: [row.min, row.max] }));
  const periods = new Map(rows.map(row => [row.period, row]));
  const fullCalendar = daily && month === 'all';
  const xTicks = fullCalendar ? monthKeys : undefined;

  function exportCsv() {
    const csvRows = rows.map(row => ({
      configuration: label,
      [daily ? 'month_day_utc' : 'weather_year']: row.period,
      minimum_earnings_eur: row.min,
      median_earnings_eur: row.median,
      maximum_earnings_eur: row.max,
    }));
    const period = daily ? (month === 'all' ? 'cumulative' : `cumulative-${month}`) : 'yearly';
    download(`btm-earnings-${period}.csv`, Papa.unparse(csvRows, { escapeFormulae: true }));
  }

  return <section id="btm-earnings" className={`${panel} scroll-mt-16 space-y-4 lg:scroll-mt-4`}>
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h3 className="text-lg font-semibold">Earnings</h3>
        <p className="mt-1 text-sm text-slate-400">{label} · {daily ? 'Year-to-date earnings by day (UTC)' : 'Annual earnings by weather year'}</p>
      </div>
      <div className="rounded-lg border border-teal-300/20 bg-teal-300/5 px-4 py-2.5">
        <p className="text-xs text-teal-100/80">Median annual earnings</p>
        <p className="mt-0.5 text-xl font-semibold tabular-nums text-teal-200">{money(annualMedian)}</p>
      </div>
    </div>
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-4">
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Earnings chart view" className="flex gap-2">
          <button type="button" className={daily ? action : secondary} aria-pressed={daily} onClick={() => setView('daily')}>Cumulative</button>
          <button type="button" className={daily ? secondary : action} aria-pressed={!daily} onClick={() => setView('yearly')}>Yearly</button>
        </div>
        {daily && <select aria-label="Earnings calendar month" className={`${field} mt-0 w-auto`} value={month} onChange={e => setMonth(e.target.value)}>
          <option value="all">All months</option>
          {monthKeys.map(key => <option key={key} value={key.slice(0, 2)}>{formatPeriod(key, monthName)}</option>)}
        </select>}
      </div>
      <button type="button" className={`${secondary} inline-flex items-center gap-2`} onClick={exportCsv} disabled={!rows.length}>
        <Download size={14} aria-hidden="true" /> Export earnings CSV
      </button>
    </div>
    <div className="h-[320px] w-full" role="img"
      aria-label={`${daily ? 'Cumulative earnings by day' : 'Earnings by weather year'} with median and minimum to maximum range`}>
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <ComposedChart data={rows} margin={{ top: 8, right: 14, bottom: 4, left: 3 }}>
          <CartesianGrid vertical={false} stroke="#26344a" strokeDasharray="3 5" />
          <XAxis dataKey="period" ticks={xTicks} tick={ticks} minTickGap={18} tickMargin={9} axisLine={false}
            tickLine={false} padding={{ left: 5, right: 5 }}
            tickFormatter={period => daily ? formatPeriod(String(period), fullCalendar ? monthName : dayName) : String(period)} />
          <YAxis width={66} tick={ticks} tickLine={false} axisLine={false} domain={['auto', 'auto']}
            tickFormatter={value => axisCurrency.format(Number(value))} />
          <ReferenceLine y={0} stroke="#475569" />
          <Tooltip cursor={{ stroke: '#94a3b8', strokeDasharray: '3 4' }} content={({ active, label: point }) => {
            const row = periods.get(String(point));
            if (!active || !row) return null;
            return <div className="space-y-1 rounded-lg border border-slate-600 bg-slate-950/95 px-3 py-2 text-sm shadow-lg">
              <p className="font-medium text-slate-100">{daily ? formatPeriod(row.period, dayName) : row.period}</p>
              <p className="tabular-nums text-teal-200">Median {money(row.median)}</p>
              <p className="tabular-nums text-slate-300">Range {money(row.min)} to {money(row.max)}</p>
            </div>;
          }} />
          <Area type="linear" dataKey="range" fill={medianColor} fillOpacity={0.16} stroke="none" isAnimationActive={false} />
          <Line type="linear" dataKey="min" stroke={rangeColor} strokeDasharray="4 4" strokeWidth={1.25}
            isAnimationActive={false} dot={rows.length === 1} />
          <Line type="linear" dataKey="max" stroke={rangeColor} strokeDasharray="4 4" strokeWidth={1.25}
            isAnimationActive={false} dot={rows.length === 1} />
          <Line type="linear" dataKey="median" stroke={medianColor} strokeWidth={2.6} isAnimationActive={false}
            dot={rows.length === 1} activeDot={{ r: 4, strokeWidth: 0 }} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-slate-400">
      <span className="inline-flex items-center gap-2"><span className="w-5 border-t-2 border-teal-300" /> Median</span>
      <span className="inline-flex items-center gap-2"><span className="h-2.5 w-5 border-y border-dashed border-slate-400 bg-teal-300/15" /> Minimum to maximum</span>
    </div>
  </section>;
}
