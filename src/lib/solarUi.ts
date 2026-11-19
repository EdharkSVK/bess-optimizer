import { useEffect, useState } from 'react';
import { ApiError } from './api';
import { getJob, queueJob } from './solar';
import type { Job } from './solar';
import type { BessParameters } from '../types';

export const panel = 'rounded-xl border border-white/10 bg-slate-900/60 p-5 min-w-0';
export const field = 'mt-1 w-full rounded-md border border-white/15 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-400';
export const action = 'rounded-md bg-sky-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-40';
export const secondary = 'rounded-md border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/10 disabled:opacity-40';
export const defaultBattery: BessParameters = { maxPowerMW: 1, capacityMWh: 4, roundtripEfficiency: .85,
  wearCostPerMWh: 20, maxCyclesPerDay: null };
export const number = (v: number, digits = 2) => new Intl.NumberFormat('en-GB', { maximumFractionDigits: digits }).format(v);
export const money = (v: number) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(v);

export function useSolarJob<T>() {
  const [id, setId] = useState('');
  const [state, setState] = useState<Job<T> | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const busy = working || Boolean(id && (!state || state.status === 'queued' || state.status === 'running'));
  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh() {
      try {
        const response = await getJob<T>(id, controller.signal);
        if (controller.signal.aborted) return;
        setState(response);
        setError(response.error ?? '');
        if (response.status === 'queued' || response.status === 'running') timer = setTimeout(refresh, 800);
      } catch (e) {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
        if (e instanceof ApiError && e.status === 404) setId('');
        else timer = setTimeout(refresh, 5000);
      }
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [id]);
  async function start(url: string, body: object) {
    setState(null);
    setId('');
    setWorking(true);
    setError('');
    try {
      setId((await queueJob(url, body)).runId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  }
  return { state, id, busy, error, start, result: state?.status === 'completed' ? state.result : undefined };
}
