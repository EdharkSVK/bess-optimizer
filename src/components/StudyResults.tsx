import { useId, useMemo, useState } from 'react';
import { Download, RotateCcw } from 'lucide-react';
import { Line, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Bar, ComposedChart, BarChart, ReferenceLine } from 'recharts';
import { download, exportDaily, exportSchedule, exportRevenue } from '../lib/exports';
import { allDates, availableYears, detailPeriods, detailSeries, filterLabel, filterResult, focusResult, grains, grainLabels, intervalLabels, monthLabel, overviewPeriods, periodKey, revenueBuckets, revenueTitles, tradeCashflowSeries } from '../lib/resultViews';
import TradeCashflowChart from './TradeCashflowChart';
import type { DateFilter, PeriodGrain, RevenueBucket } from '../lib/resultViews';
import { markets } from '../types';
import type { Market, OptimizationResult } from '../types';

const labels: Record<Market, string> = { daa: 'Day-ahead auction', ida: 'Intraday auction', idc: 'Intraday continuous (ID1)' };
const colors: Record<Market, string> = { daa: '#60a5fa', ida: '#2dd4bf', idc: '#fbbf24' };
const revenueLabels: Record<Market, string> = { daa: 'DAA', ida: 'IDA', idc: 'ID' };
const panel = 'bg-white/5 border border-white/10 rounded-xl p-5';
const selectClass = 'min-w-0 rounded-md border border-white/15 bg-slate-950 px-2.5 py-2 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500';
const money = (value: number | null) => value === null ? 'Not supplied' : new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 }).format(value);
const number = (value: number) => new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 }).format(value);
const tooltipStyle = { backgroundColor: '#0f172a', border: '1px solid #475569', borderRadius: 8, color: '#f1f5f9' };
const tickStyle = { fontSize: 11, fill: '#94a3b8' };
const nullableNumber = (value: number | null) => value === null ? '—' : number(value);

function OverviewTooltip({ active, label, rows }: { active?: boolean; label?: string | number; rows: RevenueBucket[] }) {
  const row = active ? rows.find(r => r.key === String(label)) : undefined;
  if (!row) return null;
  return <div className="rounded-lg border border-slate-600 bg-slate-950 p-3 text-xs shadow-lg">
    <p className="font-medium text-slate-100 mb-2">{row.label}</p>
    {row.modelledDays ? <>
      {markets.filter(m => row.marketRevenue[m] !== null).map(m => <p key={m} style={{ color: colors[m] }}>{revenueLabels[m]}: {money(row.marketRevenue[m])}</p>)}
      <p>Gross margin: {money(row.totalRevenue)}</p><p className="text-amber-300">Wear: {money(row.wearCost)}</p>
      <p className="text-emerald-300">Wear-adjusted margin: {money(row.wearAdjustedMargin)}</p>
      <p className="text-violet-300 mt-1">Total cycles: {nullableNumber(row.cycles)}</p>
      <p className="text-sky-300">Average cycles / modelled day: {nullableNumber(row.averageCyclesPerDay)}</p>
    </> : <p>No modelled data</p>}
    <p className="text-slate-400 mt-2">{row.modelledDays} modelled / {row.calendarDays} calendar days{row.modelledDays < row.calendarDays ? ' · partial period' : ''}</p>
  </div>;
}

function GrainSelect({ value, onChange, label }: { value: PeriodGrain; onChange: (value: PeriodGrain) => void; label: string }) {
  return <select aria-label={label} className={selectClass} value={value} onChange={e => onChange(e.target.value as PeriodGrain)}>
    {grains.map(grain => <option key={grain} value={grain}>{grainLabels[grain]}</option>)}
  </select>;
}

export default function StudyResults({ result }: { result: OptimizationResult }) {
  const [filter, setFilter] = useState<DateFilter>(allDates);
  const [focusGrain, setFocusGrain] = useState<'all' | PeriodGrain>('all');
  const [focusKey, setFocusKey] = useState('');
  const [revenueGrain, setRevenueGrain] = useState<PeriodGrain>('month');
  const [detailGrain, setDetailGrain] = useState<PeriodGrain>('day');
  const [selectedPeriod, setSelectedPeriod] = useState('');
  const syncId = useId();
  const baseFiltered = useMemo(() => filterResult(result, filter), [result, filter]);
  const focusPeriods = useMemo(() => focusGrain === 'all' ? [] : overviewPeriods(baseFiltered.coverage, focusGrain), [baseFiltered.coverage, focusGrain]);
  const focusPeriod = focusPeriods.find(p => p.key === focusKey) ?? focusPeriods[0];
  const filtered = useMemo(() => focusGrain !== 'all' && focusPeriod ? focusResult(baseFiltered, focusGrain, focusPeriod.date) : baseFiltered,
    [baseFiltered, focusGrain, focusPeriod]);
  const revenues = useMemo(() => revenueBuckets(filtered, revenueGrain), [filtered, revenueGrain]);
  const periods = useMemo(() => detailPeriods(filtered.daily, detailGrain), [filtered.daily, detailGrain]);
  const period = periods.find(p => p.key === selectedPeriod) ?? periods[0];
  const detailDays = useMemo(() => filtered.daily.filter(day => periodKey(day.date, detailGrain) === period?.key), [filtered.daily, detailGrain, period?.key]);
  const detail = useMemo(() => detailSeries(detailDays, detailGrain), [detailDays, detailGrain]);
  const cashflows = useMemo(() => tradeCashflowSeries(detailDays, detailGrain), [detailDays, detailGrain]);
  const hasData = filtered.daily.length > 0;
  const scope = focusGrain !== 'all' && focusPeriod ? `${focusPeriod.label} · within ${filterLabel(filter).toLowerCase()}` : filterLabel(filter);
  const suffix = `${filter.year}-${filter.month}${focusGrain !== 'all' && focusPeriod ? `-${focusGrain}-${focusPeriod.key}` : ''}`;
  const detailTotal = detailDays.reduce((sum, d) => sum+d.totalRevenue, 0);
  const detailCycles = detailDays.reduce((sum, d) => sum+d.cycles, 0);
  const detailMargin = detailDays.reduce((sum, d) => sum+d.wearAdjustedMargin, 0);
  const modelledPeriods = revenues.filter(row => row.modelledDays > 0).length;
  const averagePerPeriod = modelledPeriods ? filtered.cycles / modelledPeriods : null;

  function changeFocus(grain: 'all' | PeriodGrain) {
    const anchor = focusPeriod?.date ?? baseFiltered.daily[0]?.date;
    setFocusKey(grain !== 'all' && anchor ? periodKey(anchor, grain) : '');
    setFocusGrain(grain);
    setRevenueGrain(grain === 'all' || grain === 'year' ? 'month' : 'day');
  }

  function changeDetailGrain(grain: PeriodGrain) {
    setSelectedPeriod(detailDays[0] ? periodKey(detailDays[0].date, grain) : '');
    setDetailGrain(grain);
  }

  return <>
    <section aria-label="Revenue period" className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="font-medium">Revenue potential</h2><p className="text-xs text-slate-400 mt-1">{scope} · {filtered.coverage.modelledDays} modelled days · {filtered.coverage.excludedDays} excluded</p></div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="revenue-year">Revenue year</label>
        <select id="revenue-year" className={selectClass} value={filter.year} onChange={e => setFilter(old => ({ ...old, year: e.target.value }))}>
          <option value="all">All years</option>{availableYears(result.coverage).map(year => <option key={year}>{year}</option>)}
        </select>
        <label className="sr-only" htmlFor="revenue-month">Revenue month</label>
        <select id="revenue-month" className={selectClass} value={filter.month} onChange={e => setFilter(old => ({ ...old, month: e.target.value }))}>
          <option value="all">All months</option>{Array.from({ length: 12 }, (_, i) => String(i+1).padStart(2, '0')).map(month => <option key={month} value={month}>{monthLabel(month)}</option>)}
        </select>
        {(filter.year !== 'all' || filter.month !== 'all' || focusGrain !== 'all') && <button type="button" className="rounded-md p-2 text-slate-400 hover:bg-white/10 hover:text-white focus:ring-2 focus:ring-blue-500" onClick={() => { setFilter(allDates); changeFocus('all'); }} aria-label="Reset revenue date filters" title="All dates"><RotateCcw size={16} /></button>}
      </div>
    </section>
    <section aria-label="Revenue and cycle chart controls" className={`${panel} space-y-3`}>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-slate-400">Show period
          <select aria-label="Overview period" className={`${selectClass} block mt-1`} value={focusGrain} onChange={e => changeFocus(e.target.value as 'all' | PeriodGrain)}>
            <option value="all">All filtered dates</option>{grains.map(grain => <option key={grain} value={grain}>One {grain}</option>)}
          </select>
        </label>
        {focusGrain !== 'all' && <label className="text-xs text-slate-400">Select {focusGrain}
          <select aria-label={`Overview ${focusGrain}`} disabled={!focusPeriods.length} className={`${selectClass} block mt-1 max-w-full`} value={focusPeriod?.key ?? ''} onChange={e => setFocusKey(e.target.value)}>
            {!focusPeriods.length && <option value="">No dates available</option>}{focusPeriods.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
        </label>}
        <label className="text-xs text-slate-400">Group charts by
          <select aria-label="Overview chart interval" className={`${selectClass} block mt-1`} value={revenueGrain} onChange={e => setRevenueGrain(e.target.value as PeriodGrain)}>
            {grains.map(grain => <option key={grain} value={grain}>{intervalLabels[grain]}</option>)}
          </select>
        </label>
      </div>
      <p className="text-xs text-slate-400">{scope} · {intervalLabels[revenueGrain]} buckets. The period sets the date range; grouping sets the size of each bar. Hover either chart to inspect revenue and cycles for the same date.</p>
    </section>
    <section aria-label={`Revenue totals: ${scope}`} className="grid grid-cols-2 xl:grid-cols-4 gap-3">
      {markets.map(m => <div className={panel} key={m}><p className="text-xs text-slate-400 mb-2">{m === 'daa' ? 'Day-ahead revenue' : m === 'ida' ? 'Incremental ID auction' : 'Incremental ID continuous'}</p><p className="text-xl font-semibold" style={{ color: colors[m] }}>{result.marketRevenue[m] === null ? 'Not supplied' : hasData ? money(filtered.marketRevenue[m]) : '—'}</p></div>)}
      <div className={panel}><p className="text-xs text-slate-400 mb-2">Gross trading margin</p><p className="text-xl font-semibold text-emerald-300">{hasData ? money(filtered.totalRevenue) : '—'}</p></div>
    </section>
    <section aria-label="Wear-adjusted economics" className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div className={panel}><p className="text-xs text-slate-400 mb-2">Estimated physical wear cost</p><p className="text-xl font-semibold text-amber-300">{hasData ? money(filtered.wearCost) : '—'}</p><p className="text-xs text-slate-400 mt-2">Run wear rate: {money(result.metadata.battery.wearCostPerMWh)} / internal discharged MWh</p></div>
      <div className={panel}><p className="text-xs text-slate-400 mb-2">Wear-adjusted trading margin</p><p className="text-xl font-semibold text-emerald-300">{hasData ? money(filtered.wearAdjustedMargin) : '—'}</p><p className="text-xs text-slate-400 mt-2">Gross margin less wear allowance · before fees and other costs; not project cash flow</p></div>
    </section>
    <section className={panel} aria-label="Revenue overview">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div><h2 className="font-medium">{revenueTitles[revenueGrain]}</h2><p className="text-xs text-slate-400 mt-1">{scope} · {number(filtered.cycles)} physical cycles · no extrapolation</p></div>
        <div className="flex items-center gap-2">
          <details className="relative export-menu" onClick={event => { if ((event.target as HTMLElement).closest('button')) event.currentTarget.open = false; }}><summary className="export-button cursor-pointer list-none"><Download size={15} />Export</summary>
            <div className="absolute right-0 top-full z-10 mt-2 w-52 rounded-lg border border-white/15 bg-slate-900 p-1 shadow-xl">
              <button className="export-menu-item" disabled={!revenues.length} onClick={() => exportRevenue(revenues, revenueGrain, suffix)}>Revenue summary CSV</button>
              <button className="export-menu-item" disabled={!hasData && !filtered.coverage.excludedDays} onClick={() => exportDaily(filtered, suffix)}>Daily CSV</button>
              <button className="export-menu-item" disabled={!hasData} onClick={() => exportSchedule(filtered, suffix)}>Quarter-hour CSV</button>
              <button className="export-menu-item" onClick={() => download(`bess-run-metadata-${suffix}.json`, JSON.stringify({ ...result.metadata, view: { ...filter, focusPeriod: focusGrain, selectedPeriod: focusPeriod?.key ?? null, revenueGrouping: revenueGrain }, coverage: filtered.coverage }, null, 2), 'application/json')}>Run metadata</button>
            </div>
          </details>
        </div>
      </div>
      {hasData ? <>
        <div aria-label="Revenue market legend" className="flex flex-wrap gap-4 text-xs mb-3">{markets.filter(m => result.coverage.markets.includes(m)).map(m => <span key={m} style={{ color: colors[m] }} title={labels[m]}>● {revenueLabels[m]}</span>)}</div>
        <div className="h-56" data-testid="revenue-chart"><ResponsiveContainer><BarChart key={`${suffix}-${revenueGrain}`} stackOffset="sign" syncId={`${syncId}-overview`} syncMethod="value" data={revenues} margin={{ top: 5, right: 45, bottom: 5, left: 5 }}><CartesianGrid stroke="#ffffff12" vertical={false} />
          <XAxis dataKey="key" interval="preserveStartEnd" minTickGap={45} tick={tickStyle} tickFormatter={key => revenues.find(r => r.key === key)?.tick ?? key} />
          <YAxis tick={tickStyle} width={50} tickFormatter={value => number(Number(value))} />
          <Tooltip cursor={{ fill: '#ffffff08' }} content={({ active, label }) => <OverviewTooltip active={active} label={label} rows={revenues} />} />
          <ReferenceLine y={0} stroke="#64748b" />
          {markets.filter(m => result.coverage.markets.includes(m)).map(m => <Bar key={m} dataKey={`marketRevenue.${m}`} name={`${revenueLabels[m]} (EUR)`} stackId="market-revenue" fill={colors[m]} isAnimationActive={false} />)}
        </BarChart></ResponsiveContainer></div>
        <details className="mt-3 text-xs text-slate-400"><summary className="cursor-pointer hover:text-slate-200">View {revenueGrain === 'day' ? 'daily' : revenueGrain === 'week' ? 'weekly' : revenueGrain === 'month' ? 'monthly' : 'yearly'} revenue, wear & cycle totals</summary>
          <div className="overflow-x-auto max-h-72 mt-3 rounded-md border border-white/10"><table className="w-full whitespace-nowrap text-right"><thead className="sticky top-0 bg-slate-900 text-slate-300"><tr>{['Period', 'DA (EUR)', 'IDA (EUR)', 'IDC (EUR)', 'Gross (EUR)', 'Wear (EUR)', 'Wear-adjusted (EUR)', 'Total cycles', 'Avg cycles / day', 'Modelled days'].map(label => <th key={label} className="px-3 py-2 font-medium first:text-left">{label}</th>)}</tr></thead><tbody>{revenues.map(row => <tr key={row.key} className="border-t border-white/5"><td className="px-3 py-2 text-left">{row.label}</td>{markets.map(m => <td key={m} className="px-3 py-2">{row.modelledDays ? money(row.marketRevenue[m]) : '—'}</td>)}{[row.totalRevenue, row.wearCost, row.wearAdjustedMargin].map((value, i) => <td key={i} className="px-3 py-2">{value === null ? '—' : money(value)}</td>)}<td className="px-3 py-2 text-violet-300">{nullableNumber(row.cycles)}</td><td className="px-3 py-2 text-sky-300">{nullableNumber(row.averageCyclesPerDay)}</td><td className="px-3 py-2">{row.modelledDays} / {row.calendarDays}</td></tr>)}</tbody></table></div>
        </details>
      </> : <p className="py-12 text-center text-sm text-slate-400" role="status">No modelled days in this period. Choose another month/year or reset the filters.</p>}
    </section>
    <section className={panel} aria-label="Physical cycle statistics">
      <div><h2 className="font-medium">Physical cycles</h2><p className="text-xs text-slate-400 mt-1">{scope} · {intervalLabels[revenueGrain]} totals · same dates as the revenue chart</p></div>
      <div className={`grid grid-cols-1 ${revenueGrain === 'day' ? 'sm:grid-cols-2' : 'sm:grid-cols-3'} gap-4 mt-4`}>
        <div><p className="text-xs text-slate-400">Total cycles · {scope}</p><p className="text-2xl font-semibold text-violet-300 mt-1">{hasData ? number(filtered.cycles) : '—'}</p></div>
        <div><p className="text-xs text-slate-400">Average cycles / modelled day</p><p className="text-2xl font-semibold text-sky-300 mt-1">{nullableNumber(filtered.averageCyclesPerDay)}</p></div>
        {revenueGrain !== 'day' && <div><p className="text-xs text-slate-400">Average total / represented {revenueGrain}</p><p className="text-2xl font-semibold text-violet-300 mt-1">{nullableNumber(averagePerPeriod)}</p></div>}
      </div>
      <p className="text-xs text-slate-400 mt-3">Equivalent full cycles = internal discharged MWh / usable capacity. Averages include modelled zero-cycle days and exclude missing dates. Period averages use {modelledPeriods} represented {revenueGrain} periods; partial periods are not extrapolated.</p>
      {hasData ? <>
        <div className="flex flex-wrap gap-4 text-xs mt-4"><span className="text-violet-300">● Total cycles / {revenueGrain} · left axis</span><span className="text-sky-300">● Average cycles / modelled day · right axis</span></div>
        <div className="h-52 mt-2" data-testid="cycle-chart"><ResponsiveContainer><ComposedChart key={`${suffix}-${revenueGrain}`} syncId={`${syncId}-overview`} syncMethod="value" data={revenues}><CartesianGrid stroke="#ffffff12" vertical={false} />
          <XAxis dataKey="key" interval="preserveStartEnd" minTickGap={45} tick={tickStyle} tickFormatter={key => revenues.find(r => r.key === key)?.tick ?? key} />
          <YAxis yAxisId="total" tick={tickStyle} width={50} /><YAxis yAxisId="average" orientation="right" tick={tickStyle} width={45} />
          <Tooltip cursor={{ stroke: '#94a3b8', strokeDasharray: '3 3' }} content={({ active, label }) => <OverviewTooltip active={active} label={label} rows={revenues} />} />
          <Bar yAxisId="total" dataKey="cycles" name={`Total cycles / ${revenueGrain}`} fill="#a78bfa" isAnimationActive={false} />
          <Line yAxisId="average" dataKey="averageCyclesPerDay" name="Average cycles / modelled day" stroke="#7dd3fc" dot={{ r: 2 }} connectNulls={false} isAnimationActive={false} />
        </ComposedChart></ResponsiveContainer></div>
      </> : <p className="py-6 text-center text-sm text-slate-400">No modelled cycle data in this period.</p>}
    </section>
    <section className={panel} aria-label="Delivery detail">
      <div className="flex flex-wrap justify-between items-start gap-3 mb-4">
        <div><h2 className="font-medium">Delivery detail</h2><p className="text-xs text-slate-400 mt-1">{period ? `${detailDays.length} modelled days · ${money(detailTotal)} gross · ${money(detailMargin)} wear-adjusted` : scope}</p>{period && <p className="text-xs text-violet-300 mt-1">{number(detailCycles)} total cycles · {number(detailCycles / detailDays.length)} average cycles / modelled day</p>}</div>
        <div className="flex max-w-full flex-wrap items-center gap-2">
          <GrainSelect value={detailGrain} onChange={changeDetailGrain} label="Delivery detail view" />
          {period && <select aria-label={`Delivery ${detailGrain}`} className={`${selectClass} max-w-full sm:max-w-72`} value={period.key} onChange={e => setSelectedPeriod(e.target.value)}>{periods.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}</select>}
        </div>
      </div>
      {period ? <>
        <p className="text-xs text-slate-400 mb-5">{detail.resolution}. Gaps indicate dates without modelled data.</p>
        <p className="text-sm text-slate-400 mb-2">Market prices · EUR/MWh{detailGrain !== 'day' ? ' (interval averages)' : ''}</p>
        <div className="flex flex-wrap gap-x-4 gap-y-1 mb-3 text-xs">{result.coverage.markets.map(m => <span key={m} style={{ color: colors[m] }}>● {labels[m]}</span>)}</div>
        <div className="h-52"><ResponsiveContainer><ComposedChart syncId={`${syncId}-delivery`} syncMethod="value" data={detail.rows}><CartesianGrid stroke="#ffffff12" vertical={false} /><XAxis dataKey="key" interval="preserveStartEnd" minTickGap={55} tick={tickStyle} tickFormatter={key => detail.rows.find(r => r.key === key)?.tick ?? key} /><YAxis tick={tickStyle} width={60} /><Tooltip contentStyle={tooltipStyle} labelFormatter={key => detail.rows.find(r => r.key === key)?.label ?? key} formatter={value => typeof value === 'number' ? number(value) : String(value)} />{result.coverage.markets.map(m => <Line key={m} dataKey={m} name={labels[m]} stroke={colors[m]} type={detailGrain === 'day' ? 'stepAfter' : 'linear'} dot={detailGrain === 'day' ? false : { r: 2, strokeWidth: 0 }} strokeWidth={2} connectNulls={false} isAnimationActive={false} />)}</ComposedChart></ResponsiveContainer></div>
        <p className="text-sm text-slate-400 mt-5 mb-2">{detailGrain === 'day' ? 'Final physical dispatch · MW' : 'Grid energy charged / discharged · MWh'} (charging below zero)</p>
        {detailGrain !== 'day' && <p className="text-xs text-slate-500 mb-2">Bars total separate quarter-hour operations within each {detailGrain === 'week' ? 'hour' : 'day'}; both directions do not imply simultaneous operation.</p>}
        <div className="h-44"><ResponsiveContainer><BarChart syncId={`${syncId}-delivery`} syncMethod="value" data={detail.rows} stackOffset="sign"><CartesianGrid stroke="#ffffff12" vertical={false} /><XAxis dataKey="key" interval="preserveStartEnd" minTickGap={55} tick={tickStyle} tickFormatter={key => detail.rows.find(r => r.key === key)?.tick ?? key} /><YAxis tick={tickStyle} width={60} /><Tooltip contentStyle={tooltipStyle} labelFormatter={key => detail.rows.find(r => r.key === key)?.label ?? key} formatter={value => typeof value === 'number' ? number(value) : String(value)} /><Bar dataKey="charge" stackId="power" name={`Charge (${detail.powerUnit})`} fill="#fb7185" isAnimationActive={false} /><Bar dataKey="discharge" stackId="power" name={`Discharge (${detail.powerUnit})`} fill="#34d399" isAnimationActive={false} /></BarChart></ResponsiveContainer></div>
        <p className="text-sm text-slate-400 mt-5 mb-2">State of charge · MWh{detailGrain === 'day' ? ' (all 97 boundaries)' : ` (${detailGrain === 'week' ? 'hourly' : 'daily'} minimum–maximum)`}</p>
        <div className="h-44"><ResponsiveContainer><ComposedChart syncId={`${syncId}-delivery`} syncMethod="value" data={detail.socRows}><CartesianGrid stroke="#ffffff12" vertical={false} /><XAxis dataKey="key" interval="preserveStartEnd" minTickGap={55} tick={tickStyle} tickFormatter={key => detail.socRows.find(r => r.key === key)?.tick ?? key} /><YAxis domain={[0, result.metadata.battery.capacityMWh]} tick={tickStyle} width={60} /><Tooltip contentStyle={tooltipStyle} labelFormatter={key => detail.socRows.find(r => r.key === key)?.label ?? key} formatter={value => Array.isArray(value) ? `${number(Number(value[0]))}–${number(Number(value[1]))}` : typeof value === 'number' ? number(value) : String(value)} /><Area dataKey={detailGrain === 'day' ? 'soc' : 'socRange'} name={detailGrain === 'day' ? 'SOC (MWh)' : 'SOC range (MWh)'} type="linear" fill="#a855f730" stroke="#c084fc" strokeWidth={2} dot={detailGrain === 'day' ? false : { r: 2, strokeWidth: 0 }} connectNulls={false} isAnimationActive={false} /></ComposedChart></ResponsiveContainer></div>
        <TradeCashflowChart rows={cashflows} enabledMarkets={result.coverage.markets} syncId={`${syncId}-delivery`} colors={colors} labels={revenueLabels} />
      </> : <p className="py-10 text-center text-sm text-slate-400">No delivery detail available for this period.</p>}
    </section>
    <details className={`${panel} text-xs text-slate-400`}><summary className="cursor-pointer text-slate-200">Model assumptions & provenance</summary><div className="mt-3 space-y-2"><p>Wrapper {result.metadata.wrapperVersion} · GLPK {result.metadata.solver.version} · all stages optimal</p><p>Adapted FlexPower model: physical direction enforced at every efficiency; no offsetting buys and sells within one market stage. {result.metadata.adaptations.efficiency && 'Physical losses and internal energy throughput. '}{result.metadata.adaptations.quarterHourlyDayAhead && '15-minute day-ahead products.'}</p><ul className="list-disc pl-4 space-y-1">{result.metadata.assumptions.map(a => <li key={a}>{a}</li>)}</ul><p>Gross margin is sales minus purchases. Wear-adjusted margin deducts the economic wear allowance once, before fees and other costs. Reconcile this allowance with replacement and augmentation costs in the project financial model to avoid double counting. Later market prices do not enter earlier stages.</p><p className="break-all">Upstream SHA-256: {result.metadata.sha256}</p></div></details>
  </>;
}
