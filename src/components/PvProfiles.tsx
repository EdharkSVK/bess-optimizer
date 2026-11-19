import { useEffect, useState } from 'react';
import { Download, Sun } from 'lucide-react';
import { getProfile, profileUrl } from '../lib/solar';
import type { Catalog, PvProfile, Technology } from '../lib/solar';
import { field, number, panel, secondary } from '../lib/solarUi';
import { ErrorMessage, FlowChart } from './SolarUi';

const solarSeries = [{ key: 'factor', label: 'PV capacity factor', color: '#fbbf24' }];
const HOUR = 3600000;

export default function PvProfiles({ catalog }: { catalog: Catalog }) {
  const [technology, setTechnology] = useState<Technology>('industrial');
  const [selection, setSelection] = useState<number>();
  const [profile, setProfile] = useState<PvProfile>();
  const [error, setError] = useState('');
  const [day, setDay] = useState('');
  const year = selection ?? catalog.years.at(-1);
  useEffect(() => {
    if (year === undefined) return;
    const controller = new AbortController();
    void getProfile(technology, year, controller.signal).then(value => {
      setProfile(value);
      setError('');
    }).catch((err: unknown) => {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
    });
    return () => controller.abort();
  }, [technology, year]);
  const active = profile?.year === year && profile?.technology === technology ? profile : undefined;
  const first = year === undefined ? '' : `${year}-01-01`;
  const last = year === undefined ? '' : `${year}-12-31`;
  const chosenDay = day >= first && day <= last ? day : first;
  const selectedHour = active ? Math.max(0, (Date.parse(chosenDay + 'T00:00:00Z') - Date.parse(active.start)) / HOUR) : 0;
  const rows = active?.capacityFactors.slice(selectedHour, selectedHour + 168).map((factor, index) => ({
    factor, datetime: new Date(Date.parse(active.start) + (selectedHour + index) * HOUR).toISOString(),
  })) ?? [];
  const coverage = catalog.years.length > 1 ? `${catalog.years[0]}–${catalog.years.at(-1)} · ${catalog.years.length} weather years`
    : catalog.years.length ? `${catalog.years[0]} · 1 weather year` : 'Catalog unavailable';

  return <div className="space-y-5">
    <div className={`${panel} flex flex-wrap items-center justify-between gap-5`}>
      <div>
        <h2 className="flex items-center gap-2 text-xl font-semibold"><Sun className="text-amber-300" size={23} /> Czech solar profiles</h2>
        <p className="mt-1 text-sm text-slate-400">{catalog.pvSource.version}</p>
      </div>
      <p className="rounded-md border border-sky-400/25 bg-sky-400/10 px-3 py-2 text-sm text-sky-200">{coverage}</p>
    </div>
    {year === undefined ? <p role="status" className={panel}>The local Copernicus catalog has no complete Czech profile years. See the profile setup in the project README.</p> :
      <section className={`${panel} space-y-5`}>
        <div className="grid gap-3 sm:grid-cols-[2fr_1fr_1.4fr_auto] sm:items-end">
          <label className="text-sm text-slate-300">PV technology
            <select className={field} value={technology} onChange={e => { setTechnology(e.target.value as Technology); setError(''); }}>
              {catalog.technologies.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </label>
          <label className="text-sm text-slate-300">Weather year
            <select className={field} value={year} onChange={e => { setSelection(Number(e.target.value)); setDay(''); setError(''); }}>
              {catalog.years.map(y => <option key={y}>{y}</option>)}
            </select>
          </label>
          <label className="text-sm text-slate-300">Week starting (UTC)
            <input type="date" className={field} value={chosenDay} min={first} max={last} onChange={e => setDay(e.target.value)} />
          </label>
          <a href={profileUrl(technology, year) + '/csv'} download className={`${secondary} flex h-10 items-center gap-2 whitespace-nowrap`}>
            <Download size={16} /> Annual CSV
          </a>
        </div>
        <ErrorMessage error={error} />
        {active ? <>
          <div className="flex flex-wrap gap-x-8 gap-y-3 border-y border-white/10 py-3">
            <div><span className="block text-xs text-slate-400">Annual full-load hours</span><strong className="text-xl text-amber-200">{number(active.fullLoadHours, 1)} h</strong></div>
            <div><span className="block text-xs text-slate-400">Hourly observations</span><strong className="text-xl">{number(active.capacityFactors.length, 0)}</strong></div>
          </div>
          <FlowChart rows={rows} series={solarSeries} unit="MW/MWp" />
        </> : !error && <p role="status" className="text-sm text-slate-400">Loading hourly capacity factors…</p>}
      </section>}
    <p className="text-sm text-slate-400">National hourly profiles represent Czech weather across the country. Source <a className="text-sky-300 underline" href={catalog.pvSource.url} target="_blank" rel="noreferrer">{catalog.pvSource.name}</a> · {catalog.pvSource.license}.</p>
  </div>;
}
