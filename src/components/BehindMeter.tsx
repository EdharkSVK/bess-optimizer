import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { btmMetrics } from '../lib/solar';
import type { BtmDetail, BtmEnergyFlows, BtmMetric, BtmResult, Catalog, Size } from '../lib/solar';
import { action, defaultBattery, field, money, number, panel, secondary, useSolarJob } from '../lib/solarUi';
import { BatteryFields, Dispatch, ErrorMessage, JobProgress, NumberField } from './SolarUi';
import BtmEnergyChart from './BtmEnergyChart';
import BtmEarningsChart from './BtmEarningsChart';

const projectFields = [
  ['pvCapexPerMWp', 'PV CAPEX (EUR/MWp)'], ['batteryCapexPerMW', 'Battery power CAPEX (EUR/MW)'],
  ['batteryCapexPerMWh', 'Battery energy CAPEX (EUR/MWh)'], ['pvOpexPerMWpYear', 'PV OPEX (EUR/MWp/year)'],
  ['batteryOpexPerMWhYear', 'Battery OPEX (EUR/MWh/year)'], ['pvLifeYears', 'PV life (years)'],
  ['batteryLifeYears', 'Battery life (years)'], ['discountRate', 'Discount rate (%)'],
] as const;
const flowSeries = [
  { key: 'loadMW', label: 'Site load', color: '#e2e8f0' }, { key: 'pvMW', label: 'PV generation', color: '#fbbf24' },
  { key: 'pvChargeMW', label: 'PV charging', color: '#c4b5fd' }, { key: 'batteryToLoadMW', label: 'Battery to load', color: '#2dd4bf' },
  { key: 'importMW', label: 'Grid import', color: '#60a5fa' }, { key: 'exportMW', label: 'Grid export', color: '#fb7185' },
];
const energyViews = [
  ['average', 'All-scenario average'], ['range', 'Selected interval'], ['day', 'Exact day'],
] as const;

function averageByHour(rows: BtmDetail['rows']): BtmEnergyFlows[] {
  if (!rows.length) return [];
  // The detail API supplies complete UTC days in chronological hourly order.
  const days = rows.length / 24;
  return Array.from({ length: 24 }, (_, hour) => {
    let loadMW = 0, pvToLoadMW = 0, pvChargeMW = 0, batteryToLoadMW = 0, exportMW = 0;
    for (let i = hour; i < rows.length; i += 24) {
      const row = rows[i];
      loadMW += row.loadMW;
      pvToLoadMW += row.pvToLoadMW;
      pvChargeMW += row.pvChargeMW;
      batteryToLoadMW += row.batteryToLoadMW;
      exportMW += row.exportMW;
    }
    return { loadMW: loadMW / days, pvToLoadMW: pvToLoadMW / days, pvChargeMW: pvChargeMW / days,
      batteryToLoadMW: batteryToLoadMW / days, exportMW: exportMW / days };
  });
}

function ProfileSelection({ label, options, values, onChange }: {
  label: string; options: string[]; values: string[] | undefined; onChange: (values: string[] | undefined) => void;
}) {
  return <div className="space-y-2">
    <label className="block text-sm text-slate-300">{label}
      <select multiple className={`${field} h-28`} value={values ?? options}
        onChange={e => onChange(Array.from(e.target.selectedOptions, option => option.value))}>
        {options.map(option => <option key={option}>{option}</option>)}
      </select>
    </label>
    <button type="button" className="text-xs text-sky-300 underline" onClick={() => onChange(undefined)}>Select all</button>
  </div>;
}

function BtmResults({ result, id, mode }: { result: BtmResult; id: string; mode: string }) {
  const [candidate, setCandidate] = useState(result.ranking[0]);
  const [year, setYear] = useState(result.years.at(-1)!);
  const [site, setSite] = useState(result.sites[0]);
  const [metric, setMetric] = useState<BtmMetric>('netSavings');
  const [view, setView] = useState<(typeof energyViews)[number][0]>('average');
  const [date, setDate] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const detail = useSolarJob<BtmDetail>();
  const [requestedScenario, setRequestedScenario] = useState('');
  const scenarioKey = `${candidate}/${year}/${site}`;
  const dispatch = requestedScenario === scenarioKey ? detail.result?.rows : undefined;
  const firstDate = `${year}-01-01`;
  const lastDate = `${year}-12-31`;
  const day = date >= firstDate && date <= lastDate ? date : `${year}-06-21`;
  const periodStart = view === 'day' ? day : from >= firstDate && from <= lastDate ? from : firstDate;
  const periodEnd = view === 'day' ? day : to >= firstDate && to <= lastDate ? to : lastDate;
  const validPeriod = periodStart <= periodEnd;
  const selectedFlows = useMemo(() => {
    if (view === 'average' || !dispatch || !validPeriod) return undefined;
    const rows = dispatch.filter(row => {
      const utcDay = row.datetime.slice(0, 10);
      return utcDay >= periodStart && utcDay <= periodEnd;
    });
    return view === 'day' ? rows : averageByHour(rows);
  }, [view, dispatch, validPeriod, periodStart, periodEnd]);
  const flows = view === 'average' ? result.candidates[candidate].averageDay : selectedFlows;
  const energyProfile = view === 'average'
    ? `All-scenario average · ${result.scenarioCount} ${result.scenarioCount === 1 ? 'scenario' : 'scenarios'} · full years`
    : view === 'day' ? `${site} · ${day} UTC` : `${site} · ${periodStart} to ${periodEnd} UTC · average by hour`;
  const energyFilename = view === 'average' ? 'btm-energy-all-scenarios.csv'
    : `btm-energy-${view === 'day' ? day : `${periodStart}-to-${periodEnd}`}.csv`;
  const recommendation = result.candidates[result.ranking[0]];
  const selectedScenario = result.candidates[candidate].scenarios.find(row => row.year === year && row.site === site)!;
  const format = (key: BtmMetric, value: number) => ['baselineBill', 'importCost', 'exportReceipts', 'wear',
    'annualizedCapex', 'fixedOpex', 'netSavings'].includes(key) ? money(value) : number(value);

  function inspect() {
    setRequestedScenario(scenarioKey);
    void detail.start(`/api/btm/runs/${id}/detail`, { candidate, year, site });
  }

  return <div className="space-y-5">
    <section className={`${panel} space-y-4`}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div><h3 className="text-lg font-semibold">Annual scenario results</h3>
          <p className="text-sm text-slate-400">{result.scenarioCount} independent scenarios · {result.years.length} weather {result.years.length === 1 ? 'year' : 'years'} × {result.sites.length} site shapes</p></div>
        {!result.costsIncluded && <span className="text-xs text-amber-200">Operating savings before project costs</span>}
      </div>
      <p className="text-sm text-slate-400">
        {result.setup.technology === 'industrial' ? 'Industrial rooftop' : 'Residential rooftop'} · {number(result.setup.annualLoadMWh)} MWh/year
        · {number(result.setup.importTariff)} EUR/MWh import · {number(result.setup.exportTariff)} EUR/MWh export
        {result.setup.exportLimitMW !== null && ` · ${number(result.setup.exportLimitMW)} MW export limit`}
      </p>
      {mode === 'sizing' && <p className="rounded-lg bg-emerald-400/10 p-3 text-sm text-emerald-200">
        Recommended size · {recommendation.label} · {recommendation.size ? `${recommendation.size.pvMWp} MWp PV / ${recommendation.size.batteryMW} MW / ${recommendation.size.batteryMWh} MWh` : 'Grid only'} · {money(recommendation.summary.netSavings.median)} median net annual savings
      </p>}
      <div className="overflow-auto"><table className="w-full min-w-[500px] text-sm">
        <thead className="border-b border-white/15 text-left text-slate-400"><tr><th className="py-2 pr-3">Configuration</th>
          {(['baselineBill', 'importCost', 'exportReceipts', 'wear', 'netSavings', 'peakImportMW', 'peakExportMW'] as const).map(key =>
            <th key={key} className="px-2 text-right font-normal">{key === 'netSavings' ? 'Median net annual savings' : btmMetrics[key]}</th>)}</tr></thead>
        <tbody>{result.ranking.map(index => { const item = result.candidates[index]; return <tr key={item.label} className="border-b border-white/10">
          <th scope="row" className="py-3 pr-3 text-left font-medium text-slate-100">{item.label}{item.size &&
            <span className="mt-0.5 block whitespace-nowrap text-xs font-normal text-slate-400">{item.size.pvMWp} MWp / {item.size.batteryMW} MW / {item.size.batteryMWh} MWh</span>}</th>
          {(['baselineBill', 'importCost', 'exportReceipts', 'wear', 'netSavings', 'peakImportMW', 'peakExportMW'] as const).map(key =>
            <td key={key} className={`px-2 text-right tabular-nums ${key === 'netSavings' ? 'font-semibold text-emerald-200' : ''}`}>
              {format(key, item.summary[key][key === 'netSavings' ? 'median' : 'mean'])}</td>)}
        </tr>; })}</tbody>
      </table></div>
      <p className="text-xs text-slate-400">The median net annual savings is the sizing result. The other columns show scenario means.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm text-slate-300">Inspect configuration<select className={field} value={candidate}
          onChange={e => setCandidate(Number(e.target.value))}>{result.candidates.map((item, index) => <option key={item.label} value={index}>{item.label}</option>)}</select></label>
        <label className="text-sm text-slate-300">Inspect metric<select className={field} value={metric}
          onChange={e => setMetric(e.target.value as BtmMetric)}>{Object.entries(btmMetrics).map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select></label>
      </div>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {(['mean', 'median', 'min', 'max'] as const).map(key => <div key={key} className="rounded-lg border border-white/10 p-3">
          <dt className="text-xs capitalize text-slate-400">{key}</dt><dd className="mt-1 font-semibold tabular-nums">{format(metric, result.candidates[candidate].summary[metric][key])}</dd>
        </div>)}
      </dl>
    </section>
    <BtmEarningsChart earnings={result.candidates[candidate].earnings}
      annualMedian={result.candidates[candidate].summary.netSavings.median} label={result.candidates[candidate].label} />
    <section className={`${panel} space-y-4`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">Consumption and production</h3>
          <p className="mt-1 text-sm text-slate-400">{result.candidates[candidate].label} · {energyProfile}</p>
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Energy chart view">
          {energyViews.map(([key, label]) => <button key={key} type="button" className={view === key ? action : secondary}
            aria-pressed={view === key} onClick={() => setView(key)}>{label}</button>)}
        </div>
      </div>
      {view !== 'average' && <>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-[repeat(4,minmax(0,1fr))_auto] sm:items-end">
          <label className="text-sm text-slate-300">Weather year<select className={field} value={year} onChange={e => {
            setYear(Number(e.target.value)); setFrom(''); setTo(''); setDate('');
          }}>{result.years.map(y => <option key={y}>{y}</option>)}</select></label>
          <label className="text-sm text-slate-300">Industrial load<select className={field} value={site} onChange={e => setSite(e.target.value)}>{result.sites.map(s => <option key={s}>{s}</option>)}</select></label>
          {view === 'day' ? <label className="text-sm text-slate-300">Date (UTC)<input className={field} type="date" min={firstDate} max={lastDate}
            value={day} onChange={e => setDate(e.target.value)} /></label> : <>
            <label className="text-sm text-slate-300">From (UTC)<input className={field} type="date" min={firstDate} max={periodEnd}
              value={periodStart} onChange={e => setFrom(e.target.value)} /></label>
            <label className="text-sm text-slate-300">Through (UTC)<input className={field} type="date" min={periodStart} max={lastDate}
              value={periodEnd} onChange={e => setTo(e.target.value)} /></label>
          </>}
          {!dispatch && <button type="button" className={secondary} onClick={inspect} disabled={detail.busy || !validPeriod}>Load dispatch</button>}
        </div>
        {!validPeriod && <ErrorMessage error="The end date must be on or after the start date." />}
        <p className="text-sm text-slate-400">Selected year and site · {format(metric, selectedScenario[metric])} {btmMetrics[metric].toLowerCase()}</p>
        <JobProgress state={detail.state} busy={detail.busy} unit="scenarios" />
        <ErrorMessage error={requestedScenario === scenarioKey ? detail.error : ''} />
      </>}
      {flows && flows.length > 0 && <>
        <BtmEnergyChart flows={flows} filename={energyFilename} profile={`${result.candidates[candidate].label} · ${energyProfile}`} />
        <p className="text-xs text-slate-400">PV sent to the battery is part of gross production. Charging deducts it below zero.</p>
      </>}
      {view !== 'average' && dispatch && <details className="border-t border-white/10 pt-3">
        <summary className="cursor-pointer text-sm text-slate-300">Full-year dispatch and CSV</summary>
        <div className="mt-3"><Dispatch key={detail.id} rows={dispatch} series={flowSeries} filename="btm-dispatch.csv" pageSize={168} /></div>
      </details>}
    </section>
  </div>;
}

export default function BehindMeter({ catalog }: { catalog: Catalog }) {
  const [technology, setTechnology] = useState<'industrial' | 'residential'>('industrial');
  const [mode, setMode] = useState<'manual' | 'sizing'>('manual');
  const [runMode, setRunMode] = useState(mode);
  const [annualLoadMWh, setAnnualLoad] = useState('');
  const [importTariff, setImportTariff] = useState('');
  const [exportTariff, setExportTariff] = useState('');
  const [exportLimitMW, setExportLimit] = useState('');
  const [battery, setBattery] = useState(defaultBattery);
  const [includeCosts, setIncludeCosts] = useState(false);
  const [costs, setCosts] = useState<Record<string, string>>({ pvLifeYears: '25', batteryLifeYears: '15', discountRate: '8' });
  const [manual, setManual] = useState<Size>({ pvMWp: '1', batteryMW: '1', batteryMWh: '4' });
  const [sizing, setSizing] = useState<Size[]>([{ pvMWp: '1', batteryMW: '0', batteryMWh: '0' }, { pvMWp: '1', batteryMW: '1', batteryMWh: '4' }]);
  const [years, setYears] = useState<string[]>();
  const [sites, setSites] = useState<string[]>();
  const job = useSolarJob<BtmResult>();
  const sizes = mode === 'manual' ? [manual] : sizing;
  const haveData = catalog.years.length > 0 && catalog.loadSites.length > 0;
  const scenarioCount = (years?.length ?? catalog.years.length) * (sites?.length ?? catalog.loadSites.length);
  const showCosts = mode === 'sizing' || includeCosts;

  function submit(event: FormEvent) {
    event.preventDefault();
    setRunMode(mode);
    void job.start('/api/btm/runs', {
      technology, mode, annualLoadMWh: Number(annualLoadMWh), importTariff: Number(importTariff),
      exportTariff: Number(exportTariff), exportLimitMW: exportLimitMW === '' ? null : Number(exportLimitMW),
      battery, years: years?.map(Number), sites,
      sizes: sizes.map(size => Object.fromEntries(Object.entries(size).map(([key, value]) => [key, Number(value)]))),
      costs: showCosts ? Object.fromEntries(projectFields.map(([key]) => [key, Number(costs[key]) / (key === 'discountRate' ? 100 : 1)])) : null,
    });
  }

  function changeSize(index: number, key: keyof Size, value: string) {
    if (mode === 'manual') setManual({ ...manual, [key]: value });
    else setSizing(sizing.map((size, i) => i === index ? { ...size, [key]: value } : size));
  }

  return <div className="space-y-5">
    <section className={panel}><h2 className="text-xl font-semibold">Behind-the-meter study</h2>
      <p className="mt-1 text-sm text-slate-400">Hourly PV self-consumption and solar-only battery charging with fixed import and export tariffs.</p>
    </section>
    {!haveData && <p className={`${panel} text-amber-200`}>The study needs the local Czech solar and German industrial load profiles.</p>}
    <form className={`${panel} space-y-5`} onSubmit={submit}>
      <fieldset className="space-y-5 disabled:opacity-60" disabled={job.busy || !haveData}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="text-sm text-slate-300">Study mode<select className={field} value={mode} onChange={e => setMode(e.target.value as typeof mode)}>
            <option value="manual">Manual size</option><option value="sizing">Size comparison</option></select></label>
          <label className="text-sm text-slate-300">PV technology<select className={field} value={technology} onChange={e => setTechnology(e.target.value as typeof technology)}>
            <option value="industrial">Industrial rooftop</option><option value="residential">Residential rooftop</option></select></label>
          <NumberField label="Annual site consumption (MWh)" value={annualLoadMWh} min={.000001} onChange={setAnnualLoad} />
          <NumberField label="Import tariff (EUR/MWh)" value={importTariff} onChange={setImportTariff} />
          <NumberField label="Export tariff (EUR/MWh)" value={exportTariff} onChange={setExportTariff} />
          <NumberField label="Optional export limit (MW)" value={exportLimitMW} onChange={setExportLimit} required={false} />
        </div>
        <div className="space-y-3 border-t border-white/10 pt-4">
          <h3 className="font-medium">{mode === 'manual' ? 'System size' : 'Candidate sizes'}</h3>
          <p className="text-xs text-slate-400">For PV only, use zero for both battery dimensions.</p>
          {sizes.map((size, index) => <div key={index} className="grid items-end gap-3 sm:grid-cols-3 lg:grid-cols-[1fr_1fr_1fr_auto]">
            <NumberField label={mode === 'manual' ? 'PV capacity (MWp)' : `Candidate ${index + 1} PV (MWp)`} value={size.pvMWp} min={.000001} onChange={v => changeSize(index, 'pvMWp', v)} />
            <NumberField label="Battery power (MW)" value={size.batteryMW} onChange={v => changeSize(index, 'batteryMW', v)} />
            <NumberField label="Usable battery energy (MWh)" value={size.batteryMWh} onChange={v => changeSize(index, 'batteryMWh', v)} />
            {mode === 'sizing' && sizing.length > 1 && <button type="button" className={secondary} onClick={() => setSizing(sizing.filter((_, i) => i !== index))}>Remove</button>}
          </div>)}
          {mode === 'sizing' && <button type="button" className={secondary} disabled={sizing.length >= 12}
            onClick={() => setSizing([...sizing, { pvMWp: '1', batteryMW: '0', batteryMWh: '0' }])}>Add candidate</button>}
        </div>
        {sizes.some(size => Number(size.batteryMW) > 0) && <details className="border-t border-white/10 pt-4">
          <summary className="cursor-pointer font-medium">Battery efficiency, wear and daily throughput</summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-3"><BatteryFields value={battery} setValue={setBattery} dimensions={false} /></div>
        </details>}
        <div className="space-y-3 border-t border-white/10 pt-4">
          {mode === 'manual' && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={includeCosts} onChange={e => setIncludeCosts(e.target.checked)} /> Include project costs</label>}
          {showCosts && <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {projectFields.map(([key, text]) => <NumberField key={key} label={text} value={costs[key] ?? ''} min={key.endsWith('Years') ? 1 : 0}
              max={key === 'discountRate' || key.endsWith('Years') ? 100 : undefined} onChange={v => setCosts({ ...costs, [key]: v })} />)}
          </div>}
        </div>
        <details className="border-t border-white/10 pt-4"><summary className="cursor-pointer font-medium">Scenario selection · {scenarioCount} combinations</summary>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <ProfileSelection label="Czech weather years" options={catalog.years.map(String)} values={years} onChange={setYears} />
            <ProfileSelection label="German industrial load shapes" options={catalog.loadSites} values={sites} onChange={setSites} />
          </div>
          <p className="mt-3 text-xs text-slate-400">{catalog.loadSource.notes} <a className="text-sky-300 underline" href={catalog.loadSource.url} target="_blank" rel="noreferrer">{catalog.loadSource.name}</a> · {catalog.loadSource.license}.</p>
        </details>
        <button className={action} type="submit" disabled={!scenarioCount}>Run {mode === 'sizing' ? 'size comparison' : 'BtM study'}</button>
      </fieldset>
      <JobProgress state={job.state} busy={job.busy} unit="scenarios" /><ErrorMessage error={job.error} />
    </form>
    {job.result && <BtmResults key={job.id} result={job.result} mode={runMode} id={job.id} />}
  </div>;
}
