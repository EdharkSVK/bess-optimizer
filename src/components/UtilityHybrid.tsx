import { useState } from 'react';
import type { FormEvent } from 'react';
import { validateStudy } from '../lib/api';
import type { Catalog, Detail, HybridResult } from '../lib/solar';
import { markets } from '../types';
import type { Market, StudyPreview } from '../types';
import { action, defaultBattery, field, money, number, panel, secondary, useSolarJob } from '../lib/solarUi';
import { BatteryFields, Dispatch, ErrorMessage, JobProgress, NumberField } from './SolarUi';
import ValidationReport from './ValidationReport';

const labels = { daa: 'Day-ahead auction', ida: 'Intraday auction', idc: 'Intraday continuous (ID1)' };
const series = [
  { key: 'pvMW', label: 'PV generation', color: '#fbbf24' }, { key: 'pvExportMW', label: 'Direct PV export', color: '#fb923c' },
  { key: 'pvChargeMW', label: 'PV charging', color: '#c4b5fd' }, { key: 'gridChargeMW', label: 'Grid charging', color: '#60a5fa' },
  { key: 'dischargeMW', label: 'Battery discharge', color: '#2dd4bf' }, { key: 'curtailMW', label: 'PV curtailment', color: '#fb7185' },
];

function HybridResults({ result, id }: { result: HybridResult; id: string }) {
  const [year, setYear] = useState(result.years.at(-1)!.year);
  const selected = result.years.find(item => item.year === year)!;
  const [selectedDate, setDate] = useState('');
  const date = selected.dates.includes(selectedDate) ? selectedDate : selected.dates[0];
  const [label, setLabel] = useState('');
  const detail = useSolarJob<Detail>();

  function inspect() {
    setLabel(`${year} · ${date} delivery day (Europe/Prague)`);
    void detail.start(`/api/hybrid/runs/${id}/detail`, { year, date });
  }

  return <div className="space-y-5">
    <section className={`${panel} space-y-4`}>
      <h3 className="text-lg font-semibold">{result.mode === 'weather' ? 'Weather sensitivity' : 'Historical backtest'}</h3>
      <p className="text-sm text-slate-400">{result.mode === 'weather' ? 'Each weather year uses the same uploaded price calendar and eligible delivery days.' : 'Each result joins observed market prices with PV reanalysis for the same delivery dates.'} Values cover modelled days.</p>
      <p className="text-sm text-slate-400">
        {number(result.setup.pvMWp)} MWp {result.setup.technology === 'fixed' ? 'fixed-tilt' : 'single-axis tracking'}
        · {result.setup.charging === 'pv' ? 'PV-only charging' : 'PV + grid charging'}
        · {number(result.setup.importLimitMW)} MW import / {number(result.setup.exportLimitMW)} MW export
        {result.priceYear !== null && ` · ${result.priceYear} prices`}
      </p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {(['mean', 'median', 'min', 'max'] as const).map(key => <div key={key} className="rounded-lg border border-white/10 p-3">
          <span className="block text-xs capitalize text-slate-400">{key} wear-adjusted margin</span>
          <strong className="mt-1 block tabular-nums">{money(result.margin[key])}</strong></div>)}
      </div>
      <div className="overflow-auto"><table className="w-full min-w-[650px] text-sm">
        <thead className="border-b border-white/15 text-left text-slate-400"><tr>{['Weather year', 'Days', 'DAA', 'IDA', 'IDC', 'Gross', 'Wear', 'Margin', 'PV charge (MWh)', 'Grid charge (MWh)'].map(text =>
          <th key={text} className="p-2 font-normal first:pl-0">{text}</th>)}</tr></thead>
        <tbody>{result.years.map(item => { const coverage = result.coverage.find(row => row.year === item.year)!; return <tr key={item.year} className="border-b border-white/10">
          <th scope="row" className="py-3 text-left">{item.year}</th>
          <td className="whitespace-nowrap p-2" title={`${coverage.firstDate} to ${coverage.lastDate}. ${coverage.excludedMarketDays} missing or unsupported market days, ${coverage.excludedPvDays} PV/calendar exclusions.`}>
            {coverage.modelledDays}/{coverage.expectedDays}{coverage.modelledDays < coverage.expectedDays && <span className="block text-xs text-amber-200">Partial coverage</span>}</td>
          {markets.map(m => <td key={m} className="p-2 tabular-nums">{money(item.marketRevenue[m])}</td>)}
          {[item.gross, item.wear, item.margin].map((value, index) => <td key={index} className="p-2 tabular-nums">{money(value)}</td>)}
          <td className="p-2 tabular-nums">{number(item.pvChargeMWh)}</td><td className="p-2 tabular-nums">{number(item.gridChargeMWh)}</td>
        </tr>; })}</tbody>
      </table></div>
      <details className="text-sm text-slate-300">
        <summary className="cursor-pointer">Delivery coverage and energy flows</summary>
        <div className="mt-2 space-y-2">{result.coverage.map((coverage, i) => <p key={coverage.year}>
          {coverage.year} · {coverage.firstDate} to {coverage.lastDate} · {coverage.excludedMarketDays} delivery days unavailable, {coverage.excludedPvDays} PV/calendar exclusions
          · PV generation {number(result.years[i].pvMWh)} MWh · direct PV exports {number(result.years[i].pvExportMWh)} MWh
          · battery discharge {number(result.years[i].dischargeMWh)} MWh · curtailment {number(result.years[i].curtailMWh)} MWh
        </p>)}</div>
      </details>
    </section>
    <section className={`${panel} space-y-3`}>
      <h3 className="text-lg font-semibold">Quarter-hour dispatch</h3>
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <label className="text-sm text-slate-300">Weather year<select className={field} value={year} onChange={e => setYear(Number(e.target.value))}>
          {result.years.map(item => <option key={item.year}>{item.year}</option>)}</select></label>
        <label className="text-sm text-slate-300">Delivery date<select className={field} value={date} onChange={e => setDate(e.target.value)}>
          {selected.dates.map(day => <option key={day}>{day}</option>)}</select></label>
        <button type="button" className={secondary} onClick={inspect} disabled={detail.busy}>Show dispatch</button>
      </div>
      <JobProgress busy={detail.busy} state={detail.state} unit="days" /><ErrorMessage error={detail.error} />
      {detail.result && <><p className="text-sm text-slate-300">{label}</p><Dispatch key={detail.id} rows={detail.result.rows} series={series} filename="utility-colocation-dispatch.csv" pageSize={96} /></>}
    </section>
  </div>;
}

export default function UtilityHybrid({ catalog }: { catalog: Catalog | undefined }) {
  const [files, setFiles] = useState<Partial<Record<Market, File>>>({});
  const [product, setProduct] = useState('auto');
  const [study, setStudy] = useState<StudyPreview>();
  const [validating, setValidating] = useState(false);
  const [error, setError] = useState('');
  const [technology, setTechnology] = useState<'fixed' | 'tracking'>('fixed');
  const [charging, setCharging] = useState<'pv' | 'pv_grid'>('pv');
  const [studyMode, setMode] = useState<'historical' | 'weather'>('historical');
  const [selectedPriceYear, setPriceYear] = useState('');
  const [pv, setPv] = useState('1');
  const [importLimit, setImportLimit] = useState('1');
  const [exportLimit, setExportLimit] = useState('2');
  const [battery, setBattery] = useState(defaultBattery);
  const job = useSolarJob<HybridResult>();
  const priceYears = [...new Set(study?.preview.includedDates.map(day => day.slice(0, 4)) ?? [])].sort();
  const priceYear = priceYears.includes(selectedPriceYear) ? selectedPriceYear : priceYears.at(-1);
  const haveData = Boolean(catalog?.years.length);

  async function validate() {
    setError('');
    setStudy(undefined);
    setValidating(true);
    try {
      setStudy(await validateStudy(files, 'Europe/Prague', product));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setValidating(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!study || !haveData) return;
    void job.start('/api/hybrid/runs', { studyId: study.studyId, technology, charging, studyMode,
      priceYear: studyMode === 'weather' && priceYear ? Number(priceYear) : null, pvMWp: Number(pv),
      importLimitMW: Number(importLimit), exportLimitMW: Number(exportLimit), battery });
  }

  return <div className="space-y-5">
    <section className={panel}><h2 className="text-xl font-semibold">Utility PV + BESS</h2>
      <p className="mt-1 text-sm text-slate-400">Trade a Czech solar and battery plant across day-ahead, intraday auction and intraday continuous markets.</p>
      {!haveData && <p className="mt-3 text-sm text-amber-200">The local Czech PV catalog must be available before calculating.</p>}
    </section>
    <form className={`${panel} space-y-5`} onSubmit={submit}>
      <fieldset className="space-y-5 disabled:opacity-60" disabled={validating || job.busy}>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="text-sm text-slate-300">PV technology<select className={field} value={technology} onChange={e => setTechnology(e.target.value as typeof technology)}>
            <option value="fixed">Utility fixed-tilt</option><option value="tracking">Utility single-axis tracking</option></select></label>
          <label className="text-sm text-slate-300">Battery charging<select className={field} value={charging} onChange={e => setCharging(e.target.value as typeof charging)}>
            <option value="pv">PV-only charging</option><option value="pv_grid">PV + grid charging</option></select></label>
          <label className="text-sm text-slate-300">Study view<select className={field} value={studyMode} onChange={e => setMode(e.target.value as typeof studyMode)}>
            <option value="historical">Historical backtest</option><option value="weather">Weather sensitivity</option></select></label>
          <NumberField label="PV capacity (MWp)" value={pv} onChange={setPv} />
          <NumberField label="Connection import limit (MW)" value={importLimit} onChange={setImportLimit} />
          <NumberField label="Connection export limit (MW)" value={exportLimit} onChange={setExportLimit} />
          <BatteryFields value={battery} setValue={setBattery} dimensions />
        </div>
        <div className="space-y-3 border-t border-white/10 pt-4">
          <h3 className="font-medium">Czech market prices</h3>
          <p className="text-xs text-slate-400">Upload all three CSVs with datetime and EUR/MWh prices using Prague delivery time. IDA and IDC need quarter-hour prices.</p>
          <div className="grid gap-3 sm:grid-cols-3">
            {markets.map(m => <label key={m} className="min-w-0 text-sm text-slate-300">{labels[m]}
              <input type="file" accept=".csv,text/csv" className={field} onChange={e => {
                setStudy(undefined); setFiles({ ...files, [m]: e.target.files?.[0] });
              }} /></label>)}
            <label className="text-sm text-slate-300">Day-ahead delivery product<select className={field} value={product} onChange={e => {
              setProduct(e.target.value); setStudy(undefined);
            }}><option value="auto">Use source cadence</option><option value="60">Hourly (including repeated quarters)</option><option value="15">15 minutes</option></select></label>
            {studyMode === 'weather' && priceYears.length > 0 && <label className="text-sm text-slate-300">Price calendar year<select className={field} value={priceYear}
              onChange={e => setPriceYear(e.target.value)}>{priceYears.map(y => <option key={y}>{y}</option>)}</select></label>}
          </div>
          <div className="flex flex-wrap gap-3">
            <button type="button" className={secondary} disabled={markets.some(m => !files[m])} onClick={() => void validate()}>{validating ? 'Validating…' : 'Validate all three market files'}</button>
            <button className={action} type="submit" disabled={!study?.preview.canRun || !haveData}>Run co-location</button>
          </div>
        </div>
      </fieldset>
      <ErrorMessage error={error || job.error} /><JobProgress state={job.state} busy={job.busy} unit="scenario days" />
    </form>
    {study && <ValidationReport key={study.studyId} coverage={study.preview} />}
    {job.result && <HybridResults key={job.id} result={job.result} id={job.id} />}
  </div>;
}
