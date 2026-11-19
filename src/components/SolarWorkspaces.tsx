import { lazy, Suspense, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { BatteryCharging, ChartNoAxesCombined, House, Sun } from 'lucide-react';
import { getCatalog } from '../lib/solar';
import type { Catalog } from '../lib/solar';
import { secondary } from '../lib/solarUi';
import { ErrorMessage } from './SolarUi';

const BehindMeter = lazy(() => import('./BehindMeter'));
const PvProfiles = lazy(() => import('./PvProfiles'));
const UtilityHybrid = lazy(() => import('./UtilityHybrid'));

export default function SolarWorkspaces({ children }: { children: ReactNode }) {
  const [workspace, setWorkspace] = useState<'utility' | 'btm'>('utility');
  const [utility, setUtility] = useState<'standalone' | 'hybrid' | 'profiles'>('standalone');
  const [btm, setBtm] = useState<'profiles' | 'study'>('profiles');
  const [openedHybrid, setOpenedHybrid] = useState(false);
  const [openedBtm, setOpenedBtm] = useState(false);
  const [catalog, setCatalog] = useState<Catalog>();
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void getCatalog(controller.signal).then(setCatalog).catch((err: unknown) => {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
    });
    return () => controller.abort();
  }, [attempt]);
  const standalone = workspace === 'utility' && utility === 'standalone';
  const hybrid = workspace === 'utility' && utility === 'hybrid';
  const btmStudy = workspace === 'btm' && btm === 'study';
  const profiles = workspace === 'utility' ? utility === 'profiles' : btm === 'profiles';
  const tabs = workspace === 'utility' ? [
    { key: 'standalone', label: 'Standalone BESS', icon: BatteryCharging },
    { key: 'hybrid', label: 'PV + BESS', icon: ChartNoAxesCombined },
    { key: 'profiles', label: 'PV profiles', icon: Sun },
  ] as const : [
    { key: 'profiles', label: 'PV profiles', icon: Sun },
    { key: 'study', label: 'BtM study', icon: ChartNoAxesCombined },
  ] as const;

  return <div className="min-h-screen bg-background font-sans text-foreground">
    <header className="border-b border-white/10 bg-slate-950/95">
      <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-3 px-6 py-4">
        <h1 className="flex items-center gap-3 text-xl font-semibold"><BatteryCharging className="text-blue-400" /> FlexOptima BESS App</h1>
        <nav aria-label="Workspace" className="flex gap-1 rounded-lg border border-white/10 bg-slate-900 p-1">
          {([{ key: 'utility', label: 'Utility BESS', icon: BatteryCharging }, { key: 'btm', label: 'Behind the Meter', icon: House }] as const)
            .map(({ key, label, icon: Icon }) => <button key={key} type="button" aria-pressed={workspace === key}
              onClick={() => setWorkspace(key)} className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm ${workspace === key ? 'bg-sky-400/15 text-sky-200' : 'text-slate-400 hover:bg-white/5'}`}>
              <Icon size={16} />{label}
            </button>)}
        </nav>
      </div>
    </header>
    <nav aria-label="Workspace views" className="mx-auto flex max-w-[1440px] gap-5 overflow-x-auto border-b border-white/10 px-6">
      {tabs.map(({ key, label, icon: Icon }) => {
        const active = workspace === 'utility' ? utility === key : btm === key;
        return <button type="button" key={key} aria-current={active ? 'page' : undefined}
          onClick={() => {
            if (workspace === 'utility' && key !== 'study') setUtility(key);
            else if (workspace === 'btm' && (key === 'profiles' || key === 'study')) setBtm(key);
            if (key === 'hybrid') setOpenedHybrid(true);
            if (key === 'study') setOpenedBtm(true);
          }}
          className={`flex items-center gap-2 whitespace-nowrap border-b-2 py-3 text-sm ${active ? 'border-sky-400 text-sky-200' : 'border-transparent text-slate-400 hover:text-slate-200'}`}>
          <Icon size={16} />{label}
        </button>;
      })}
    </nav>
    <div hidden={!standalone}>{children}</div>
    <main hidden={standalone} className="mx-auto max-w-[1440px] px-6 py-7">
      {!catalog && <div className="mb-4 space-y-2">
        {error ? <><ErrorMessage error={error} /><button type="button" className={secondary} onClick={() => { setError(''); setAttempt(attempt + 1); }}>Reload profile catalog</button></> :
          <p role="status" className="text-sm text-slate-400">Loading profile catalog…</p>}
      </div>}
      <Suspense fallback={<p role="status" className="text-sm text-slate-400">Loading workspace…</p>}>
        {openedHybrid && <div hidden={!hybrid}><UtilityHybrid catalog={catalog} /></div>}
        {catalog && profiles && <PvProfiles catalog={catalog} />}
        {openedBtm && catalog && <div hidden={!btmStudy}><BehindMeter catalog={catalog} /></div>}
      </Suspense>
    </main>
  </div>;
}
