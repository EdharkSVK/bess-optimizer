import { useEffect, useState } from 'react';
import { BatteryCharging, Upload, Settings2, Play, X, AlertCircle } from 'lucide-react';
import { ApiError, getRun, startRun, validateStudy } from './lib/api';
import StudyResults from './components/StudyResults';
import ValidationReport from './components/ValidationReport';
import { markets } from './types';
import type { BessParameters, Market, RunState, StudyPreview } from './types';

const labels: Record<Market, string> = { daa: 'Day-ahead auction', ida: 'Intraday auction', idc: 'Intraday continuous (ID1)' };
const colors: Record<Market, string> = { daa: '#60a5fa', ida: '#2dd4bf', idc: '#fbbf24' };
const inputClass = 'w-full bg-slate-950 border border-white/15 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500';
const panel = 'bg-white/5 border border-white/10 rounded-xl p-5';

function App() {
  const [files, setFiles] = useState<Partial<Record<Market, File>>>({});
  const [timezone, setTimezone] = useState('Europe/Prague');
  const [product, setProduct] = useState('auto');
  const [params, setParams] = useState<BessParameters>({ capacityMWh: 4, maxPowerMW: 1, roundtripEfficiency: .85, wearCostPerMWh: 20, maxCyclesPerDay: null });
  const [study, setStudy] = useState<StudyPreview | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<RunState | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [pollError, setPollError] = useState('');
  const busy = working || (runId !== null && (!run || run.status === 'queued' || run.status === 'running'));
  const result = run?.status === 'completed' ? run.result : undefined;
  const validBattery = Number.isFinite(params.capacityMWh) && params.capacityMWh > 0 &&
    Number.isFinite(params.maxPowerMW) && params.maxPowerMW > 0 &&
    Number.isFinite(params.roundtripEfficiency) && params.roundtripEfficiency > 0 && params.roundtripEfficiency <= 1 &&
    Number.isFinite(params.wearCostPerMWh) && params.wearCostPerMWh >= 0 &&
    (params.maxCyclesPerDay === null || (Number.isFinite(params.maxCyclesPerDay) && params.maxCyclesPerDay >= 0));

  function invalidate() { setStudy(null); setRun(null); setRunId(null); setError(''); }
  function changeFile(market: Market, file?: File) {
    invalidate(); setFiles(old => { const next = { ...old }; if (file) next[market] = file; else delete next[market]; return next; });
  }
  function changeBattery(key: keyof BessParameters, value: number | null) { invalidate(); setParams(old => ({ ...old, [key]: value })); }
  async function validate() {
    setWorking(true); setError(''); setStudy(null); setRun(null); setRunId(null);
    try { setStudy(await validateStudy(files, timezone, product)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setWorking(false); }
  }
  async function calculate() {
    if (!study || !validBattery) return;
    setWorking(true); setError(''); setPollError(''); setRun(null); setRunId(null);
    try { const response = await startRun(study.studyId, params); setRunId(response.runId); }
    catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      if (e instanceof ApiError && e.status === 404) setStudy(null);
    } finally { setWorking(false); }
  }
  useEffect(() => {
    if (!runId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let disposed = false;
    async function poll() {
      try {
        const state = await getRun(runId!, controller.signal);
        if (disposed) return;
        setRun(state); setPollError('');
        if (state.status === 'failed') setError(state.error || 'Calculation failed.');
        if (state.status === 'queued' || state.status === 'running') timer = setTimeout(poll, 600);
      } catch (e) {
        if (disposed) return;
        const message = e instanceof Error ? e.message : String(e);
        if (e instanceof ApiError && e.status === 404) {
          setError(message); setStudy(null); setRunId(null); setRun(null);
        } else {
          setPollError(`${message} Retrying status in 5 seconds.`);
          timer = setTimeout(poll, 5000);
        }
      }
    }
    void poll();
    return () => { disposed = true; controller.abort(); clearTimeout(timer); };
  }, [runId]);

  return <div className="min-h-screen bg-background text-foreground font-sans">
    <header className="border-b border-white/10 bg-slate-950/90 sticky top-0 z-20 backdrop-blur-md">
      <div className="max-w-[1440px] mx-auto px-6 h-16 flex items-center justify-between gap-4">
        <h1 className="text-xl font-semibold flex items-center gap-3"><BatteryCharging className="text-blue-400" />FlexOptima BESS App</h1>
        <span className="text-xs text-slate-400 text-right">Historical three-market revenue potential</span>
      </div>
    </header>
    <main className="max-w-[1440px] mx-auto px-6 py-8 grid grid-cols-1 lg:grid-cols-12 gap-7">
      <aside className="lg:col-span-4 xl:col-span-3 space-y-5">
        <section className={panel}>
          <h2 className="font-medium flex gap-2 items-center mb-4"><Settings2 size={19} className="text-blue-400" />Battery settings</h2>
          <fieldset disabled={busy} className="space-y-4 disabled:opacity-60">
            {([
              ['capacityMWh', 'Usable capacity (MWh)', .01, undefined, .1],
              ['maxPowerMW', 'Grid-side power (MW)', .01, undefined, .1],
              ['roundtripEfficiency', 'Round-trip efficiency (%)', .01, 100, 1],
              ['wearCostPerMWh', 'Wear cost (EUR / internal discharged MWh)', 0, undefined, 1],
            ] as const).map(([key, label, min, max, step]) => <label key={key} className="block text-sm text-slate-300">
              {label}<input className={`${inputClass} mt-1.5`} type="number" min={min} max={max} step={step}
                value={Number.isNaN(params[key]) ? '' : key === 'roundtripEfficiency' ? Number((params[key] * 100).toPrecision(12)) : params[key]}
                onChange={e => changeBattery(key, e.target.valueAsNumber / (key === 'roundtripEfficiency' ? 100 : 1))} />
            </label>)}
            <p className="text-xs text-slate-400 leading-relaxed">The selected wear cost influences dispatch and applies per internal discharged MWh. Calibrate it to the battery; zero disables the wear penalty.</p>
            <details className="text-sm text-slate-300"><summary className="cursor-pointer">Optional contractual cycle limit</summary>
              <label className="block mt-3">Maximum equivalent full cycles / day
                <input aria-label="Optional maximum cycles per day" className={`${inputClass} mt-1.5`} type="number" min={0} step={.1} placeholder="No additional cap"
                  value={params.maxCyclesPerDay === null || Number.isNaN(params.maxCyclesPerDay) ? '' : params.maxCyclesPerDay}
                  onChange={e => changeBattery('maxCyclesPerDay', e.target.value === '' ? null : e.target.valueAsNumber)} />
              </label><p className="text-xs text-slate-400 mt-2">Leave blank unless a warranty or agreement requires a daily limit. Capacity, power and energy-balance limits always apply.</p>
            </details>
          </fieldset>
          <p className="text-xs text-slate-400 mt-4 leading-relaxed">Every modelled day starts and ends empty. A cycle is internal discharged MWh divided by capacity. Physical charging and discharging cannot overlap, even at 100% efficiency.</p>
          {!validBattery && <p className="text-sm text-rose-300 mt-3">Enter positive capacity and power, efficiency above 0% up to 100%, and non-negative wear cost and optional cycle limit.</p>}
        </section>
        <section className={panel}>
          <h2 className="font-medium flex gap-2 items-center mb-2"><Upload size={19} className="text-emerald-400" />Market prices</h2>
          <p className="text-xs text-slate-400 mb-4">Upload any 1, 2 or 3 markets. Columns: <code>datetime,price</code>. Prices in EUR/MWh.</p>
          <fieldset disabled={busy} className="space-y-3 disabled:opacity-60">
            {markets.map(m => <div key={m} className="rounded-lg border border-white/15 bg-black/20 p-3">
              <div className="flex items-center justify-between gap-2 mb-2"><label htmlFor={`file-${m}`} className="text-sm font-medium" style={{ color: colors[m] }}>{labels[m]}</label>
                {files[m] && <button type="button" aria-label={`Remove ${labels[m]} file`} title="Remove file" onClick={() => changeFile(m)} className="text-slate-400 hover:text-white"><X size={16} /></button>}
              </div>
              <input key={files[m]?.name ?? 'empty'} id={`file-${m}`} type="file" accept=".csv,text/csv" className="w-full text-xs text-slate-400 file:mr-2 file:rounded file:border-0 file:bg-white/10 file:px-2 file:py-1.5 file:text-slate-200"
                onChange={e => { const f = e.target.files?.[0]; if (f) changeFile(m, f); }} />
              {files[m] && <p className="text-xs text-emerald-300 mt-2 break-all">{files[m]!.name}</p>}
              <a href={`/examples/${m}.csv`} download className="text-xs text-blue-300 hover:underline mt-2 inline-block">Download {m.toUpperCase()} example / template</a>
            </div>)}
            <label className="block text-sm text-slate-300">Study timezone
              <input className={`${inputClass} mt-1.5`} list="timezones" value={timezone} onChange={e => { invalidate(); setTimezone(e.target.value); }} />
              <datalist id="timezones">{['Europe/Prague', 'Europe/Berlin', 'Europe/Paris', 'Europe/London', 'UTC'].map(z => <option key={z} value={z} />)}</datalist>
            </label>
            {files.daa && <label className="block text-sm text-slate-300">Day-ahead delivery product
              <select className={`${inputClass} mt-1.5`} value={product} onChange={e => { invalidate(); setProduct(e.target.value); }}>
                <option value="auto">Auto: use each day’s file cadence</option><option value="60">Hourly (including repeated quarters)</option><option value="15">15 minutes</option>
              </select>
            </label>}
          </fieldset>
          <p className="text-xs text-slate-400 mt-3">All files must use the same bidding zone and EUR/MWh. Intraday inputs require 15-minute delivery prices. ID1 represents one price per delivery quarter. Use the hourly DA override for hourly prices exported as repeated quarters.</p>
          <button onClick={() => void validate()} disabled={busy || !Object.keys(files).length || !validBattery} className="w-full mt-4 rounded-md bg-white/10 hover:bg-white/15 px-3 py-2.5 text-sm disabled:opacity-40">{working ? 'Working…' : 'Validate files & preview coverage'}</button>
          {study && <button onClick={() => void calculate()} disabled={busy || !study.preview.canRun || !validBattery} className="w-full mt-3 rounded-md bg-blue-600 hover:bg-blue-500 px-3 py-2.5 font-medium flex justify-center gap-2 items-center disabled:opacity-40"><Play size={17} />{busy ? 'Calculating…' : `Run optimization · ${study.preview.modelledDays} days`}</button>}
        </section>
        <p className="text-xs text-slate-500 leading-relaxed">Uses the <a className="text-blue-300 underline" href="https://github.com/FlexPwr/bess-optimizer" target="_blank" rel="noreferrer">FlexPower optimizer</a>, with physical safeguards, efficiency and quarter-hour DA extensions. Historical potential assumes future prices are known; it is not an executable trading backtest.</p>
      </aside>
      <div className="lg:col-span-8 xl:col-span-9 space-y-5 min-w-0">
        {error && <div role="alert" className="border border-rose-500/40 bg-rose-500/10 text-rose-200 rounded-xl p-4 flex gap-2"><AlertCircle className="shrink-0" size={19} /><span>{error}</span></div>}
        {study && <ValidationReport key={study.studyId} coverage={study.preview} />}
        {busy && runId && <section className={panel} aria-live="polite"><p className="text-sm mb-3">{run?.status === 'queued' || !run ? 'Queued' : 'Calculating'} · {run?.completedDays ?? 0} / {run?.totalDays ?? study?.preview.modelledDays} days {run?.currentDate && `· ${run.currentDate}`} {run?.currentMarket && `· ${labels[run.currentMarket]}`}</p><progress className="w-full accent-blue-500" max={run?.totalDays || 1} value={run?.completedDays ?? 0} />{pollError && <div role="alert" className="text-amber-300 text-sm mt-3">{pollError}<button onClick={() => { setRunId(null); setRun(null); setStudy(null); setPollError(''); }} className="block underline mt-2">Reset local view after disconnect</button></div>}</section>}
        {result ? <StudyResults key={runId} result={result} />  : !busy && !error && <section className={`${panel} min-h-64 flex items-center justify-center text-center text-slate-400`}><div><BatteryCharging className="mx-auto mb-4 text-blue-400" size={38} /><p className="text-lg text-slate-200">Three markets. One battery.</p><p className="text-sm mt-2 max-w-md">Choose battery settings, upload any market combination, then preview the common delivery days and calculate revenue potential.</p></div></section>}
      </div>
    </main>
  </div>;
}
export default App;
