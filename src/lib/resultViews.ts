import type { Coverage, DayResult, Market, MarketRevenue, OptimizationResult } from '../types';

export type PeriodGrain = 'day' | 'week' | 'month' | 'year';
export interface DateFilter { year: string; month: string; startDate?: string; endDate?: string }
export const allDates: DateFilter = { year: 'all', month: 'all' };
export const grains: PeriodGrain[] = ['day', 'week', 'month', 'year'];
export const grainLabels: Record<PeriodGrain, string> = { day: 'Day', week: 'Week', month: 'Month', year: 'Year' };
export const intervalLabels: Record<PeriodGrain, string> = { day: 'Daily', week: 'Weekly', month: 'Monthly', year: 'Yearly' };
export const revenueTitles: Record<PeriodGrain, string> = { day: 'Daily revenue', week: 'Weekly revenue', month: 'Monthly revenue', year: 'Yearly revenue' };
const marketKeys: Market[] = ['daa', 'ida', 'idc'];
const dateValue = (date: string) => new Date(`${date}T00:00:00Z`);
const isoDate = (date: Date) => date.toISOString().slice(0, 10);
const dateFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const shortDateFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const monthFormat = new Intl.DateTimeFormat('en-GB', { month: 'long', timeZone: 'UTC' });

export function addDays(date: string, days: number) {
  const value = dateValue(date); value.setUTCDate(value.getUTCDate() + days); return isoDate(value);
}

export function periodStart(date: string, grain: PeriodGrain): string {
  if (grain === 'year') return `${date.slice(0, 4)}-01-01`;
  if (grain === 'month') return `${date.slice(0, 7)}-01`;
  if (grain === 'week') return addDays(date, -((dateValue(date).getUTCDay() + 6) % 7));
  return date;
}

export function periodEnd(date: string, grain: PeriodGrain): string {
  const start = periodStart(date, grain);
  if (grain === 'day') return start;
  if (grain === 'week') return addDays(start, 6);
  const value = dateValue(start);
  if (grain === 'month') value.setUTCMonth(value.getUTCMonth() + 1);
  else value.setUTCFullYear(value.getUTCFullYear() + 1);
  return addDays(isoDate(value), -1);
}

export function periodKey(date: string, grain: PeriodGrain) {
  return periodStart(date, grain).slice(0, grain === 'year' ? 4 : grain === 'month' ? 7 : 10);
}

export function periodLabel(date: string, grain: PeriodGrain) {
  const start = periodStart(date, grain);
  if (grain === 'year') return start.slice(0, 4);
  if (grain === 'month') return `${monthFormat.format(dateValue(start))} ${start.slice(0, 4)}`;
  if (grain === 'week') return `${dateFormat.format(dateValue(start))} – ${dateFormat.format(dateValue(periodEnd(start, grain)))}`;
  return dateFormat.format(dateValue(start));
}

export function monthLabel(month: string) { return monthFormat.format(dateValue(`2000-${month}-01`)); }
export function matchesFilter(date: string, filter: DateFilter) {
  return (filter.year === 'all' || date.slice(0, 4) === filter.year) && (filter.month === 'all' || date.slice(5, 7) === filter.month)
    && (!filter.startDate || date >= filter.startDate) && (!filter.endDate || date <= filter.endDate);
}
export function filterLabel(filter: DateFilter) {
  if (filter.month === 'all') return filter.year === 'all' ? 'All dates' : filter.year;
  return `${monthLabel(filter.month)} ${filter.year === 'all' ? '· all years' : filter.year}`;
}
export function availableYears(coverage: Coverage) {
  return [...new Set([...coverage.includedDates, ...coverage.excludedDates.map(d => d.date)].map(d => d.slice(0, 4)))].sort();
}

// Include excluded dates so a selected missing day is an explicit empty view,
// rather than silently jumping to a different, modelled day.
export function overviewPeriods(coverage: Coverage, grain: PeriodGrain) {
  const dates = [...new Set([...coverage.includedDates, ...coverage.excludedDates.map(d => d.date)])].sort();
  return [...new Map(dates.map(date => [periodKey(date, grain),
    { key: periodKey(date, grain), date: periodStart(date, grain), label: periodLabel(date, grain) }])).values()];
}

export function focusResult(result: OptimizationResult, grain: PeriodGrain, date: string) {
  return filterResult(result, { ...allDates, startDate: periodStart(date, grain), endDate: periodEnd(date, grain) });
}

export function filterResult(result: OptimizationResult, filter: DateFilter): OptimizationResult {
  const daily = result.daily.filter(d => matchesFilter(d.date, filter));
  const excludedDates = result.coverage.excludedDates.filter(d => matchesFilter(d.date, filter));
  const marketRevenue = Object.fromEntries(marketKeys.map(m => [m, result.marketRevenue[m] === null ? null : daily.reduce((sum, d) => sum + (d.marketRevenue[m] ?? 0), 0)])) as MarketRevenue;
  return { ...result, daily, marketRevenue, totalRevenue: daily.reduce((sum, d) => sum + d.totalRevenue, 0),
    cycles: daily.reduce((sum, d) => sum + d.cycles, 0),
    internalDischargedMWh: daily.reduce((sum, d) => sum + d.internalDischargedMWh, 0),
    wearCost: daily.reduce((sum, d) => sum + d.wearCost, 0),
    wearAdjustedMargin: daily.reduce((sum, d) => sum + d.wearAdjustedMargin, 0),
    averageCyclesPerDay: daily.length ? daily.reduce((sum, d) => sum + d.cycles, 0) / daily.length : null,
    coverage: { ...result.coverage, includedDates: daily.map(d => d.date), excludedDates,
      modelledDays: daily.length, excludedDays: excludedDates.length, canRun: daily.length > 0 } };
}

export interface RevenueBucket {
  key: string; date: string; label: string; tick: string; calendarDays: number;
  modelledDays: number; excludedDays: number; totalRevenue: number | null;
  marketRevenue: MarketRevenue; cycles: number | null;
  averageCyclesPerDay: number | null; internalDischargedMWh: number | null;
  wearCost: number | null; wearAdjustedMargin: number | null;
}

export function revenueBuckets(result: OptimizationResult, grain: PeriodGrain): RevenueBucket[] {
  const groups = new Map<string, RevenueBucket>();
  function get(date: string) {
    const key = periodKey(date, grain);
    let bucket = groups.get(key);
    if (!bucket) {
      const start = periodStart(date, grain);
      const tick = grain === 'year' ? key : grain === 'month'
        ? new Intl.DateTimeFormat('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' }).format(dateValue(start))
        : shortDateFormat.format(dateValue(start));
      bucket = { key, date: start, label: periodLabel(date, grain), tick,
        calendarDays: (dateValue(periodEnd(date, grain)).getTime() - dateValue(start).getTime()) / 86400000 + 1,
        modelledDays: 0, excludedDays: 0, totalRevenue: null, cycles: null,
        averageCyclesPerDay: null, internalDischargedMWh: null, wearCost: null, wearAdjustedMargin: null,
        marketRevenue: { daa: null, ida: null, idc: null } };
      groups.set(key, bucket);
    }
    return bucket;
  }
  for (const day of result.daily) {
    const bucket = get(day.date);
    bucket.modelledDays++;
    bucket.totalRevenue = (bucket.totalRevenue ?? 0) + day.totalRevenue;
    bucket.cycles = (bucket.cycles ?? 0) + day.cycles;
    bucket.averageCyclesPerDay = bucket.cycles / bucket.modelledDays;
    bucket.internalDischargedMWh = (bucket.internalDischargedMWh ?? 0) + day.internalDischargedMWh;
    bucket.wearCost = (bucket.wearCost ?? 0) + day.wearCost;
    bucket.wearAdjustedMargin = (bucket.wearAdjustedMargin ?? 0) + day.wearAdjustedMargin;
    for (const m of marketKeys) if (day.marketRevenue[m] !== null) bucket.marketRevenue[m] = (bucket.marketRevenue[m] ?? 0) + day.marketRevenue[m]!;
  }
  for (const day of result.coverage.excludedDates) get(day.date).excludedDays++;
  return [...groups.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function detailPeriods(days: DayResult[], grain: PeriodGrain) {
  return [...new Map(days.map(day => [periodKey(day.date, grain),
    { key: periodKey(day.date, grain), label: periodLabel(day.date, grain) }])).values()];
}

export interface DetailPoint {
  key: string; label: string; tick: string;
  daa: number | null; ida: number | null; idc: number | null;
  charge: number | null; discharge: number | null; soc: number | null; socRange: [number, number] | null;
}
export interface DetailSeries { rows: DetailPoint[]; socRows: DetailPoint[]; powerUnit: 'MW' | 'MWh'; resolution: string }

export const cashflowLegs = ['buy', 'sell', 'buyToClose', 'sellToClose'] as const;
export type CashflowLeg = typeof cashflowLegs[number];
export interface TradeCashflow { receipts: number; payments: number; energyMWh: number }
export interface CashflowPoint {
  key: string; label: string; tick: string;
  cashByMarket: Partial<Record<Market, Record<CashflowLeg, TradeCashflow>>>;
  net: number | null; wearCost: number | null; wearAdjustedMargin: number | null;
}

export function tradeCashflowSeries(days: DayResult[], grain: PeriodGrain): CashflowPoint[] {
  const grouped = new Map<string, CashflowPoint>();
  for (const day of days) for (const point of day.schedule) {
    const key = grain === 'day' ? point.datetime : grain === 'week' ? point.datetime.slice(0, 13) : day.date;
    let group = grouped.get(key);
    if (!group) {
      group = { key, label: '', tick: '', cashByMarket: {}, net: 0, wearCost: 0, wearAdjustedMargin: 0 };
      grouped.set(key, group);
    }
    group.wearCost! += point.wearCost;
    for (const market of marketKeys) {
      const trade = point.trades[market];
      if (!trade) continue;
      const legs = group.cashByMarket[market] ??= {
        buy: { receipts: 0, payments: 0, energyMWh: 0 }, sell: { receipts: 0, payments: 0, energyMWh: 0 },
        buyToClose: { receipts: 0, payments: 0, energyMWh: 0 }, sellToClose: { receipts: 0, payments: 0, energyMWh: 0 },
      };
      for (const leg of cashflowLegs) {
        const energy = .25 * trade[`${leg}MW` as const];
        const cash = energy * trade.price * (leg === 'buy' || leg === 'buyToClose' ? -1 : 1);
        legs[leg].energyMWh += energy;
        // Keep opposite cash directions separate even within an aggregated hour/day.
        // Purchases at negative prices are receipts, not payments.
        legs[leg].receipts += Math.max(cash, 0);
        legs[leg].payments += Math.min(cash, 0);
        group.net! += cash;
      }
    }
    group.wearAdjustedMargin = group.net! - group.wearCost!;
  }
  // Reuse the physical charts' exact time keys and gaps for synchronized hover.
  return detailSeries(days, grain).rows.map(({ key, label, tick }) => ({
    ...(grouped.get(key) ?? { cashByMarket: {}, net: null, wearCost: null, wearAdjustedMargin: null }),
    key, label, tick,
  }));
}

export function detailSeries(days: DayResult[], grain: PeriodGrain): DetailSeries {
  if (!days.length) return { rows: [], socRows: [], powerUnit: 'MW', resolution: '' };
  if (grain === 'day') {
    const day = days[0];
    const rows = day.schedule.map(p => ({ key: p.datetime, label: p.datetime.slice(11, 16), tick: p.datetime.slice(11, 16),
      daa: p.trades.daa?.price ?? null, ida: p.trades.ida?.price ?? null, idc: p.trades.idc?.price ?? null,
      charge: -p.chargeMW, discharge: p.dischargeMW, soc: p.socStartMWh, socRange: null }));
    return { rows, socRows: [...rows, { ...rows[rows.length - 1], key: `${day.date}T24:00`, label: '24:00', tick: '24:00', soc: day.schedule[day.schedule.length - 1].socEndMWh }],
      powerUnit: 'MW', resolution: 'Quarter-hour dispatch · all 97 SOC boundaries' };
  }
  // Aggregate energy (MWh), never sum power (MW). Prices are interval means;
  // SOC is an observed min/max envelope, not a fictitious averaged trajectory.
  const grouped = new Map<string, { prices: Record<Market, number[]>; charge: number; discharge: number; min: number; max: number }>();
  for (const day of days) for (const p of day.schedule) {
    const key = grain === 'week' ? p.datetime.slice(0, 13) : day.date;
    let group = grouped.get(key);
    if (!group) { group = { prices: { daa: [], ida: [], idc: [] }, charge: 0, discharge: 0, min: Infinity, max: -Infinity }; grouped.set(key, group); }
    group.charge += .25 * p.chargeMW; group.discharge += .25 * p.dischargeMW;
    group.min = Math.min(group.min, p.socStartMWh, p.socEndMWh); group.max = Math.max(group.max, p.socStartMWh, p.socEndMWh);
    for (const m of marketKeys) { const price = p.trades[m]?.price; if (price !== undefined) group.prices[m].push(price); }
  }
  const rows: DetailPoint[] = [];
  const start = periodStart(days[0].date, grain), end = periodEnd(days[0].date, grain);
  for (let date = start; date <= end; date = addDays(date, 1)) {
    for (let hour = 0; hour < (grain === 'week' ? 24 : 1); hour++) {
      const key = grain === 'week' ? `${date}T${String(hour).padStart(2, '0')}` : date;
      const group = grouped.get(key);
      const average = (market: Market) => group?.prices[market].length ? group.prices[market].reduce((s, p) => s+p, 0) / group.prices[market].length : null;
      const label = `${dateFormat.format(dateValue(date))}${grain === 'week' ? ` ${String(hour).padStart(2, '0')}:00` : ''}`;
      rows.push({ key, label, tick: grain === 'week' ? `${shortDateFormat.format(dateValue(date))} ${String(hour).padStart(2, '0')}:00` : shortDateFormat.format(dateValue(date)),
        daa: average('daa'), ida: average('ida'), idc: average('idc'),
        charge: group ? -group.charge : null, discharge: group?.discharge ?? null, soc: null, socRange: group ? [group.min, group.max] : null });
    }
  }
  return { rows, socRows: rows, powerUnit: 'MWh', resolution: grain === 'week' ? 'Hourly price averages, energy totals and SOC ranges' : 'Daily price averages, energy totals and SOC ranges' };
}
