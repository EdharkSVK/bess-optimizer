import { request } from './api';
import type { Market } from '../types';

export type Technology = 'residential' | 'industrial' | 'fixed' | 'tracking';
type Source = { name: string; url: string; license: string; version?: string; notes?: string };

export interface Catalog {
  years: number[];
  targetYears: [number, number];
  technologies: { id: Technology; label: string }[];
  pvSource: Source;
  loadSource: Source;
  loadSites: string[];
}

export interface PvProfile {
  technology: Technology;
  year: number;
  start: string;
  fullLoadHours: number;
  capacityFactors: number[];
}

export interface Job<T> {
  runId: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  total: number;
  completed: number;
  current?: string;
  error: string | null;
  result?: T;
}

export interface Stats { mean: number; median: number; min: number; max: number }

export const btmMetrics = {
  baselineBill: 'Baseline bill', importCost: 'Import cost', exportReceipts: 'Export receipts',
  wear: 'Wear allowance', annualizedCapex: 'Annualized CAPEX', fixedOpex: 'Annual OPEX',
  netSavings: 'Net annual savings', peakImportMW: 'Peak import (MW)', peakExportMW: 'Peak export (MW)',
  importedMWh: 'Grid imports (MWh)', exportedMWh: 'Grid exports (MWh)', pvMWh: 'PV generation (MWh)',
  curtailedMWh: 'Curtailed PV (MWh)', cycles: 'Equivalent full cycles',
};
export type BtmMetric = keyof typeof btmMetrics;
export interface Size { pvMWp: string; batteryMW: string; batteryMWh: string }
export interface BtmEnergyFlows {
  loadMW: number;
  pvToLoadMW: number;
  pvChargeMW: number;
  batteryToLoadMW: number;
  exportMW: number;
}
type EarningsRange = Pick<Stats, 'min' | 'median' | 'max'>;
export interface BtmEarnings {
  daily: (EarningsRange & { date: string })[];
  yearly: (EarningsRange & { year: number })[];
}
export interface BtmResult {
  years: number[];
  sites: string[];
  scenarioCount: number;
  costsIncluded: boolean;
  ranking: number[];
  setup: { technology: 'industrial' | 'residential'; annualLoadMWh: number; importTariff: number;
    exportTariff: number; exportLimitMW: number | null };
  candidates: {
    label: string;
    size: { [K in keyof Size]: number } | null;
    summary: Record<BtmMetric, Stats>;
    earnings: BtmEarnings;
    averageDay: BtmEnergyFlows[];
    scenarios: (Record<BtmMetric, number> & { year: number; site: string })[];
  }[];
}

export interface HybridYear {
  year: number;
  dates: string[];
  marketRevenue: Record<Market, number>;
  gross: number;
  wear: number;
  margin: number;
  pvMWh: number;
  pvChargeMWh: number;
  pvExportMWh: number;
  gridChargeMWh: number;
  dischargeMWh: number;
  exportMWh: number;
  curtailMWh: number;
}

export interface HybridResult {
  years: HybridYear[];
  coverage: { year: number; modelledDays: number; expectedDays: number; excludedMarketDays: number;
    excludedPvDays: number; firstDate: string; lastDate: string }[];
  mode: 'historical' | 'weather';
  priceYear: number | null;
  setup: { technology: 'fixed' | 'tracking'; pvMWp: number; charging: 'pv' | 'pv_grid';
    importLimitMW: number; exportLimitMW: number };
  margin: Stats;
}

export type PlotRow = { datetime: string } & Record<string, string | number>;
export interface Detail { rows: PlotRow[] }
export interface BtmDetail { rows: (PlotRow & BtmEnergyFlows)[] }
export interface Series { key: string; label: string; color: string }

export const getCatalog = (signal: AbortSignal) => request<Catalog>('/api/profiles', { signal });
export const profileUrl = (technology: Technology, year: number) => `/api/profiles/pv/${technology}/${year}`;
export const getProfile = (technology: Technology, year: number, signal: AbortSignal) =>
  request<PvProfile>(profileUrl(technology, year), { signal });
export const getJob = <T,>(id: string, signal: AbortSignal) => request<Job<T>>(`/api/runs/${id}`, { signal });
export const queueJob = (endpoint: string, body: object) => request<{ runId: string }>(endpoint, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
