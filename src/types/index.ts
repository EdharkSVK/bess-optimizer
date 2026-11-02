export const markets = ['daa', 'ida', 'idc'] as const;
export type Market = typeof markets[number];
export type MarketRevenue = Record<Market, number | null>;
export interface BessParameters {
  capacityMWh: number; maxPowerMW: number;
  roundtripEfficiency: number; wearCostPerMWh: number; maxCyclesPerDay: number | null;
}
export interface ValidationIssue {
  market: Market; filename: string; code: string; message: string;
  date: string | null; row: number | null; endRow: number | null;
  datetime: string | null; price: string | null; relatedRow: number | null;
  scope: 'day' | 'row' | 'file'; missingTimestamps: string[];
}
export interface Coverage {
  timezone: string; dayAheadProduct: string; markets: Market[];
  files: { market: Market; filename: string; rowCount: number; validRowCount: number;
    firstDate: string | null; lastDate: string | null; intervalsMinutes: number[]; sha256: string;
    status: 'ready' | 'needs_attention' | 'unreadable'; issueCount: number }[];
  includedDates: string[]; excludedDates: { date: string; reasons: string[] }[];
  modelledDays: number; excludedDays: number; canRun: boolean;
  issues: ValidationIssue[]; issueCount: number; blockingFiles: Market[];
}
export interface StudyPreview { studyId: string; preview: Coverage }
export interface Trade {
  price: number; buyMW: number; sellMW: number;
  buyToCloseMW: number; sellToCloseMW: number; revenue: number;
}
export interface SchedulePoint {
  datetime: string; chargeMW: number; dischargeMW: number;
  socStartMWh: number; socEndMWh: number; revenue: number;
  internalDischargedMWh: number; cycles: number; wearCost: number; wearAdjustedMargin: number;
  trades: Partial<Record<Market, Trade>>;
}
export interface DayResult {
  date: string; marketRevenue: MarketRevenue; totalRevenue: number; cycles: number;
  internalDischargedMWh: number; wearCost: number; wearAdjustedMargin: number; averageCyclesPerDay: number;
  schedule: SchedulePoint[]; dayAheadProductMinutes: number | null;
  stages: Partial<Record<Market, { socBoundariesMWh: number[]; solverStatus: string }>>;
}
export interface OptimizationResult {
  marketRevenue: MarketRevenue; totalRevenue: number; cycles: number;
  internalDischargedMWh: number; wearCost: number; wearAdjustedMargin: number; averageCyclesPerDay: number | null;
  daily: DayResult[]; coverage: Coverage;
  metadata: {
    source: string; sha256: string; wrapperVersion: string;
    solver: { name: string; version: string; sourceSha256: string };
    battery: BessParameters; timezone: string; assumptions: string[];
    adaptations: { efficiency: boolean; quarterHourlyDayAhead: boolean; physicalExclusivity: boolean; sameStageTradeExclusivity: boolean };
  };
}
export interface RunState {
  runId: string; status: 'queued' | 'running' | 'completed' | 'failed';
  completedDays: number; totalDays: number; currentDate: string | null;
  currentMarket: Market | null; error: string | null; result?: OptimizationResult;
}
