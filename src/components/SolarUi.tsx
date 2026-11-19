import { useState } from 'react';
import Papa from 'papaparse';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { download } from '../lib/exports';
import { field, secondary } from '../lib/solarUi';
import type { Job, PlotRow, Series } from '../lib/solar';
import type { BessParameters } from '../types';

export function ErrorMessage({ error }: { error: string }) {
  return error ? <p role="alert" className="rounded-lg border border-rose-400/30 bg-rose-500/10 p-3 text-sm text-rose-200">{error}</p> : null;
}

export function JobProgress({ state, busy, unit }: { state: Job<unknown> | null; busy: boolean; unit: string }) {
  return busy && <div aria-live="polite" className="space-y-2">
    <p className="text-sm text-sky-200">{state?.status === 'running' ? `${state.completed} / ${state.total} ${unit}` : 'Queued'}{state?.current && ` · ${state.current}`}</p>
    <progress className="w-full accent-sky-400" max={state?.total || 1} value={state?.completed || 0} />
  </div>;
}

export function NumberField({ label, value, onChange, min = 0, max, required = true }: {
  label: string; value: string | number; onChange: (value: string) => void; min?: number; max?: number; required?: boolean;
}) {
  return <label className="block text-sm text-slate-300">{label}
    <input className={field} type="number" step="any" min={min} max={max} required={required}
      value={value} onChange={event => onChange(event.target.value)} />
  </label>;
}

export function BatteryFields({ value, setValue, dimensions }: {
  value: BessParameters; setValue: (value: BessParameters) => void; dimensions: boolean;
}) {
  const fields = [
    ...(dimensions ? [['maxPowerMW', 'Battery power (MW)', .000001, undefined, 1],
      ['capacityMWh', 'Usable energy (MWh)', .000001, undefined, 1]] as const : []),
    ['roundtripEfficiency', 'Round-trip efficiency (%)', .01, 100, 100],
    ['wearCostPerMWh', 'Wear (EUR / internal discharged MWh)', 0, undefined, 1],
    ['maxCyclesPerDay', 'Optional daily cycle limit', 0, undefined, 1],
  ] as const;
  return <>{fields.map(([key, text, min, max, factor]) =>
    <NumberField key={key} label={text} min={min} max={max} required={key !== 'maxCyclesPerDay'}
      value={value[key] == null || Number.isNaN(value[key]) ? '' : +((value[key] ?? 0) * factor).toPrecision(12)}
      onChange={v => setValue({ ...value, [key]: v === '' ? (key === 'maxCyclesPerDay' ? null : NaN) : Number(v) / factor })} />)}</>;
}

export function FlowChart({ rows, series, unit }: { rows: PlotRow[]; series: Series[]; unit: string }) {
  return <div className="h-[330px] w-full" role="img" aria-label={series.map(s => s.label).join(', ') + ' by delivery time'}>
    <ResponsiveContainer width="100%" height="100%" minWidth={0}>
      <LineChart data={rows} margin={{ top: 14, right: 18, bottom: 0, left: 8 }}>
        <CartesianGrid stroke="#26344a" strokeDasharray="3 5" vertical={false} />
        <XAxis dataKey="datetime" minTickGap={36} tick={{ fill: '#94a3b8', fontSize: 11 }}
          tickFormatter={v => `${String(v).slice(5, 10)} ${String(v).slice(11, 16)}`} />
        <YAxis tick={{ fill: '#94a3b8', fontSize: 11 }} label={{ value: unit, angle: -90, position: 'insideLeft', fill: '#94a3b8' }} />
        <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #475569', borderRadius: 8 }}
          labelStyle={{ color: '#e2e8f0' }} labelFormatter={v => String(v).slice(0, 16).replace('T', ' ') + ' UTC'} />
        <Legend />
        {series.map(s => <Line key={s.key} type="linear" dataKey={s.key} name={s.label} stroke={s.color}
          dot={false} strokeWidth={1.8} isAnimationActive={false} />)}
      </LineChart>
    </ResponsiveContainer>
  </div>;
}

export function Dispatch({ rows, series, filename, pageSize }: {
  rows: PlotRow[]; series: Series[]; filename: string; pageSize: number;
}) {
  const [start, setStart] = useState(0);
  const count = Math.ceil(rows.length / pageSize);
  const page = Math.min(start, Math.max(count - 1, 0));
  if (!rows.length) return null;
  return <div className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        {count > 1 && <><button type="button" className={secondary} disabled={!page} onClick={() => setStart(page - 1)}>Previous week</button>
          <button type="button" className={secondary} disabled={page + 1 >= count} onClick={() => setStart(page + 1)}>Next week</button></>}
        <span className="text-sm text-slate-400">{rows[page * pageSize].datetime.slice(0, 10)} UTC</span>
      </div>
      <button type="button" className={secondary} onClick={() => download(filename, Papa.unparse(rows))}>Export dispatch CSV</button>
    </div>
    <FlowChart rows={rows.slice(page * pageSize, (page + 1) * pageSize)} series={series} unit="MW" />
    {rows.some(row => 'socMWh' in row) && <FlowChart rows={rows.slice(page * pageSize, (page + 1) * pageSize)}
      series={[{ key: 'socMWh', label: 'End-of-interval state of charge', color: '#c4b5fd' }]} unit="MWh" />}
  </div>;
}
