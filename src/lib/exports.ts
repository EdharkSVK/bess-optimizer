import Papa from 'papaparse';
import { markets } from '../types';
import type { Coverage, OptimizationResult } from '../types';
import type { PeriodGrain, RevenueBucket } from './resultViews';

export function download(name: string, text: string, type = 'text/csv;charset=utf-8;') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url; link.download = name;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function validationRows(coverage: Coverage) {
  return coverage.issues.map(issue => ({
    market: issue.market.toUpperCase(), filename: issue.filename,
    csv_line: issue.row, csv_end_line: issue.endRow, related_line: issue.relatedRow,
    delivery_date: issue.date, supplied_datetime: issue.datetime, supplied_price: issue.price,
    issue: issue.code, explanation: issue.message,
    action: issue.scope === 'file' ? 'Correct or remove file before running'
      : issue.scope === 'row' ? 'Row skipped; delivery date unknown' : 'Day excluded from all uploaded markets',
    missing_delivery_starts: issue.missingTimestamps.join('\n'),
  }));
}
export function exportValidation(coverage: Coverage) {
  download('bess-validation-issues.csv', Papa.unparse(validationRows(coverage), { escapeFormulae: true }));
}
export function scheduleRows(result: OptimizationResult) {
  return result.daily.flatMap(day => day.schedule.map(point => {
    const row: Record<string, string | number | null> = {
      datetime: point.datetime, charge_mw: point.chargeMW, discharge_mw: point.dischargeMW,
      soc_start_mwh: point.socStartMWh, soc_end_mwh: point.socEndMWh, revenue_eur: point.revenue,
      internal_discharged_mwh: point.internalDischargedMWh, physical_cycles: point.cycles,
      wear_cost_eur: point.wearCost, wear_adjusted_margin_eur: point.wearAdjustedMargin,
    };
    markets.forEach(m => {
      const t = point.trades[m];
      row[`${m}_price_eur_mwh`] = t?.price ?? null;
      row[`${m}_buy_mw`] = t?.buyMW ?? null; row[`${m}_sell_mw`] = t?.sellMW ?? null;
      row[`${m}_buy_to_close_mw`] = t?.buyToCloseMW ?? null;
      row[`${m}_sell_to_close_mw`] = t?.sellToCloseMW ?? null;
      row[`${m}_revenue_eur`] = t?.revenue ?? null;
    });
    return row;
  }));
}
export function dailyRows(result: OptimizationResult) {
  const rows: Record<string, string | number | null>[] = result.daily.map(day => ({
    date: day.date, status: 'modelled', reason: '', daa_revenue_eur: day.marketRevenue.daa,
    ida_revenue_eur: day.marketRevenue.ida, idc_revenue_eur: day.marketRevenue.idc,
    total_revenue_eur: day.totalRevenue, physical_cycles: day.cycles,
    internal_discharged_mwh: day.internalDischargedMWh, average_cycles_per_modelled_day: day.averageCyclesPerDay,
    wear_cost_eur: day.wearCost, wear_adjusted_margin_eur: day.wearAdjustedMargin,
  }));
  result.coverage.excludedDates.forEach(day => rows.push({ date: day.date, status: 'excluded',
    reason: day.reasons.join('; '), daa_revenue_eur: null, ida_revenue_eur: null,
    idc_revenue_eur: null, total_revenue_eur: null, physical_cycles: null,
    internal_discharged_mwh: null, average_cycles_per_modelled_day: null,
    wear_cost_eur: null, wear_adjusted_margin_eur: null }));
  return rows.sort((a, b) => String(a.date).localeCompare(String(b.date)));
}
export function exportSchedule(result: OptimizationResult, suffix = '') {
  download(`bess-quarter-hour-schedule${suffix ? `-${suffix}` : ''}.csv`, Papa.unparse(scheduleRows(result)));
}
export function exportDaily(result: OptimizationResult, suffix = '') {
  download(`bess-daily-revenue${suffix ? `-${suffix}` : ''}.csv`, Papa.unparse(dailyRows(result)));
}
export function revenueRows(rows: RevenueBucket[]) {
  return rows.map(row => ({
    period: row.key, label: row.label, modelled_days: row.modelledDays, excluded_days: row.excludedDays,
    calendar_days: row.calendarDays, daa_revenue_eur: row.marketRevenue.daa, ida_revenue_eur: row.marketRevenue.ida,
    idc_revenue_eur: row.marketRevenue.idc, total_revenue_eur: row.totalRevenue, physical_cycles: row.cycles,
    internal_discharged_mwh: row.internalDischargedMWh, average_cycles_per_modelled_day: row.averageCyclesPerDay,
    wear_cost_eur: row.wearCost, wear_adjusted_margin_eur: row.wearAdjustedMargin,
  }));
}
export function exportRevenue(rows: RevenueBucket[], grain: PeriodGrain, suffix: string) {
  download(`bess-${grain}-revenue-${suffix}.csv`, Papa.unparse(revenueRows(rows)));
}
