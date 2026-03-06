export interface PriceDataPoint {
    datetime: string;
    price: number;
}

export interface BessParameters {
    capacityMWh: number;
    maxPowerMW: number;
    roundtripEfficiency: number; // 0.0 to 1.0
    startingSoc: number; // 0.0 to 1.0
    lookaheadWindowHours: number;
    dataIntervalMinutes: number; // 60 or 15
}

export interface DispatchSchedulePoint {
    datetime: string;
    price: number;
    soc: number;
    chargeMW: number;
    dischargeMW: number;
    revenue: number;
    cost: number;
    profit: number;
}

export interface OptimizationResult {
    schedule: DispatchSchedulePoint[];
    totalRevenue: number;
    totalCost: number;
    netProfit: number;
    cyclesCount: number;
}
