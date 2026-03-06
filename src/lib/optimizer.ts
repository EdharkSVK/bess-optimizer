import solver from "javascript-lp-solver";
import { BessParameters, DispatchSchedulePoint, PriceDataPoint, OptimizationResult } from "../types";

export function optimizeBessDispatch(
    prices: PriceDataPoint[],
    params: BessParameters
): OptimizationResult {
    if (prices.length === 0) {
        return {
            schedule: [],
            totalRevenue: 0,
            totalCost: 0,
            netProfit: 0,
            cyclesCount: 0,
        };
    }

    const {
        capacityMWh,
        maxPowerMW,
        roundtripEfficiency,
        startingSoc,
        lookaheadWindowHours,
        dataIntervalMinutes,
    } = params;

    // Calculate scaling factor based on interval length. 
    // If 60 min -> 1.0 (MW = MWh). If 15 min -> 0.25 (1 MW for 15 min = 0.25 MWh).
    const hoursPerInterval = dataIntervalMinutes / 60;
    const sqrtEff = Math.sqrt(roundtripEfficiency);

    // We optimize in windows to mimic rolling horizon. 
    // But for pure backtesting, we can simplify by optimizing the whole dataset if it's small enough,
    // or window by window. LP-solver in JS can handle a few thousand variables but might choke on 8760 * 2.
    // We'll chunk the optimization if needed, but for MVP let's build the LP model dynamically.

    // A standard approach for large datasets is to optimize day by day (with end state = next day start state).
    // LP Model:
    // variables: charge_t, discharge_t, soc_t
    // intType: Continuous
    // minimize (or maximize) objective: sum(discharge_t * price_t * hoursPerInterval) - sum(charge_t * price_t * hoursPerInterval)
    // constraints:
    // soc_t = soc_{t-1} + charge_t * sqrtEff * hours - (discharge_t / sqrtEff) * hours
    // 0 <= soc_t <= maxCapacity
    // 0 <= charge_t <= maxPower
    // 0 <= discharge_t <= maxPower

    // NOTE: LP-solver requires standard form.

    const optimizedSchedule: DispatchSchedulePoint[] = [];
    let currentSoc = startingSoc * capacityMWh;
    let totalRevenue = 0;
    let totalCost = 0;

    // For simplicity and performance, we'll chunk by the lookahead window.
    // Typically rolling horizon: optimize N hours ahead, keep the first M hours (e.g., optimize 24h, execute 24h).
    const intervalsPerWindow = Math.floor((lookaheadWindowHours * 60) / dataIntervalMinutes);

    for (let startIdx = 0; startIdx < prices.length; startIdx += intervalsPerWindow) {
        const endIdx = Math.min(startIdx + intervalsPerWindow, prices.length);
        const chunkPrices = prices.slice(startIdx, endIdx);

        // Build LP Model
        const model: any = {
            optimize: "profit",
            opType: "max",
            constraints: {},
            variables: {},
        };

        // Initialize constraints
        for (let t = 0; t < chunkPrices.length; t++) {
            // SOC constraints
            model.constraints[`max_soc_${t}`] = { max: capacityMWh };
            model.constraints[`min_soc_${t}`] = { min: 0 };

            // Power constraints
            model.constraints[`max_charge_${t}`] = { max: maxPowerMW };
            model.constraints[`max_discharge_${t}`] = { max: maxPowerMW };

            // State transition constraint: soc_t = soc_{t-1} + C - D
            // Rearranged for LP: soc_t - soc_{t-1} - C + D = 0 => soc_t - C + D = soc_{t-1}
            // Actually: soc_t - charge_t * eff_chg * dt + discharge_t / eff_dis * dt = soc_{t-1}
            const isFirst = t === 0;
            model.constraints[`soc_transition_${t}`] = { equal: isFirst ? currentSoc : 0 };
        }

        const epsilonEndDay = 0.001; // constraint tolerance

        // If constraint 5 is "end day state = next day start state", 
        // we simply don't force end day SOC to 0 unless specified. We pass the SOC to next window.
        // If it's a fixed window, let's just optimize.

        for (let t = 0; t < chunkPrices.length; t++) {
            const price = chunkPrices[t].price;
            const energyFactor = hoursPerInterval;

            const chargeVar = `chg_${t}`;
            const dischargeVar = `dis_${t}`;
            const socVar = `soc_${t}`;

            model.variables[chargeVar] = {
                profit: -price * energyFactor,
                [`max_charge_${t}`]: 1,
                // soc_t - chg*eff + dis/eff - soc_{t-1} = 0
                [`soc_transition_${t}`]: -sqrtEff * energyFactor,
            };

            model.variables[dischargeVar] = {
                profit: price * energyFactor,
                [`max_discharge_${t}`]: 1,
                [`soc_transition_${t}`]: (1 / sqrtEff) * energyFactor,
            };

            model.variables[socVar] = {
                profit: 0,
                [`max_soc_${t}`]: 1,
                [`min_soc_${t}`]: 1,
                [`soc_transition_${t}`]: 1,
            };

            // Link to next state if not last
            if (t < chunkPrices.length - 1) {
                model.variables[socVar][`soc_transition_${t + 1}`] = -1;
            }
        }

        // Solve LP
        const results = solver.Solve(model);

        // Reconstruct Schedule
        for (let t = 0; t < chunkPrices.length; t++) {
            const p = chunkPrices[t];
            const chg = results[`chg_${t}`] || 0;
            const dis = results[`dis_${t}`] || 0;
            const soc = results[`soc_${t}`] || 0;

            const cost = chg * p.price * hoursPerInterval;
            const rev = dis * p.price * hoursPerInterval;

            totalCost += cost;
            totalRevenue += rev;

            currentSoc = soc; // propagate for next window

            optimizedSchedule.push({
                datetime: p.datetime,
                price: p.price,
                soc: currentSoc,
                chargeMW: chg,
                dischargeMW: dis,
                revenue: rev,
                cost: cost,
                profit: rev - cost,
            });
        }
    }

    // Calculate approximate cycles: Total discharged MWh / Capacity MWh
    const totalDischargedMWh = optimizedSchedule.reduce((sum, p) => sum + (p.dischargeMW * hoursPerInterval), 0);
    const cyclesCount = capacityMWh > 0 ? totalDischargedMWh / capacityMWh : 0;

    return {
        schedule: optimizedSchedule,
        totalRevenue,
        totalCost,
        netProfit: totalRevenue - totalCost,
        cyclesCount,
    };
}
