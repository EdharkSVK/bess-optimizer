"""Sequential utility co-location at a single point of interconnection."""
from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timedelta
from math import sqrt
from typing import Literal
from zoneinfo import ZoneInfo

import numpy as np
import pyomo.environ as pyo
from pydantic import Field
from pyomo.opt import SolverStatus, TerminationCondition

from .btm import Inputs, stats
from .domain import Battery, MARKETS
from .engine import CalculationError, close, solver_info, solver_path
from .profiles import HOUR, UTC, year_start

QUARTER = timedelta(minutes=15)
DURATION = 0.25


class HybridRequest(Inputs):
    studyId: str
    technology: Literal["fixed", "tracking"]
    pvMWp: float = Field(ge=0)
    importLimitMW: float = Field(ge=0)
    exportLimitMW: float = Field(ge=0)
    charging: Literal["pv", "pv_grid"] = "pv"
    studyMode: Literal["historical", "weather"] = "historical"
    priceYear: int | None = None
    battery: Battery


def utc_hours(day, zone):
    midnight = datetime.fromisoformat(day).replace(tzinfo=zone).astimezone(UTC)
    return [midnight + i * HOUR for i in range(24)]


def prepare_hybrid(request, study, catalog):
    if study.timezone != "Europe/Prague" or tuple(study.preview["markets"]) != MARKETS:
        raise ValueError("Utility PV + BESS requires DAA, IDA and IDC files in the Europe/Prague timezone.")
    years = catalog.years()
    if not years:
        raise ValueError("The Czech PV catalog is unavailable.")
    zone = ZoneInfo(study.timezone)
    by_year = defaultdict(list)
    for key in study.days:
        by_year[date.fromisoformat(key).year].append(key)
    coverage = []
    scenarios = {}

    def remember(weather_year, days, expected, missing):
        if days:
            scenarios[weather_year] = tuple(days)
            coverage.append(dict(year=weather_year, modelledDays=len(days), expectedDays=expected,
                                 excludedMarketDays=expected - len(days) - missing, excludedPvDays=missing,
                                 firstDate=days[0], lastDate=days[-1]))

    if request.studyMode == "weather":
        price_year = request.priceYear if request.priceYear is not None else max(by_year, default=0)
        if price_year not in by_year:
            raise ValueError("Select a price year with common complete delivery days.")
        # If a Czech delivery day touches UTC February 29 it must be excluded as a whole.
        days = [key for key in by_year[price_year]
                if all((t.month, t.day) != (2, 29) for t in utc_hours(key, zone))]
        for year in years:
            remember(year, days, (date(price_year + 1, 1, 1) - date(price_year, 1, 1)).days,
                     len(by_year[price_year]) - len(days))
    else:
        for year, keys in sorted(by_year.items()):
            days = [key for key in keys if all(t.year in years for t in utc_hours(key, zone))]
            remember(year, days, (date(year + 1, 1, 1) - date(year, 1, 1)).days, len(keys) - len(days))
    if not scenarios:
        raise ValueError("No common complete delivery days have both PV and all three market prices.")
    return scenarios, coverage


def pv_quarters(catalog, request, year, key, zone):
    result = []
    for stamp in utc_hours(key, zone):
        if request.studyMode == "weather":
            stamp = stamp.replace(year=year)
        index = (stamp - year_start(stamp.year)) // HOUR
        result.append(catalog.pv(request.technology, stamp.year)[index] * request.pvMWp)
    return np.repeat(result, 4)


def solve_hybrid_stage(request, market, data, pv, previous, previous_wear, solver):
    battery = request.battery
    pmax, capacity = battery.maxPowerMW, battery.capacityMWh
    eta = sqrt(battery.roundtripEfficiency)
    n = len(pv)
    grid_limit = min(request.importLimitMW, pmax) if request.charging == "pv_grid" else 0
    export_limit = request.exportLimitMW
    model = pyo.ConcreteModel()
    model.q = pyo.RangeSet(0, n - 1)
    model.s = pyo.RangeSet(0, n)
    model.pv_to_battery = pyo.Var(model.q, bounds=lambda _, q: (0, min(pmax, float(pv[q]))))
    model.pv_export = pyo.Var(model.q, bounds=lambda _, q: (0, min(export_limit, float(pv[q]))))
    model.grid_to_battery = pyo.Var(model.q, bounds=(0, grid_limit))
    model.discharge = pyo.Var(model.q, bounds=(0, min(pmax, export_limit)))
    model.soc = pyo.Var(model.s, bounds=(0, capacity))
    model.soc[0].fix(0)
    model.soc[n].fix(0)
    model.battery_direction = pyo.Var(model.q, domain=pyo.Binary)
    model.charge = pyo.Expression(model.q, rule=lambda m, q: m.pv_to_battery[q] + m.grid_to_battery[q])
    model.export = pyo.Expression(model.q, rule=lambda m, q: m.pv_export[q] + m.discharge[q])
    model.net = pyo.Expression(model.q, rule=lambda m, q: m.export[q] - m.grid_to_battery[q])
    model.pv_balance = pyo.Constraint(model.q, rule=lambda m, q: m.pv_to_battery[q] + m.pv_export[q] <= float(pv[q]))
    model.charge_power = pyo.Constraint(model.q, rule=lambda m, q: m.charge[q] <= pmax * m.battery_direction[q])
    model.discharge_power = pyo.Constraint(model.q, rule=lambda m, q: m.discharge[q] <= pmax * (1 - m.battery_direction[q]))
    if grid_limit:
        model.grid_direction = pyo.Var(model.q, domain=pyo.Binary)
        model.import_power = pyo.Constraint(model.q, rule=lambda m, q: m.grid_to_battery[q] <= grid_limit * m.grid_direction[q])
        model.export_power = pyo.Constraint(model.q, rule=lambda m, q: m.export[q] <= export_limit * (1 - m.grid_direction[q]))
    else:
        model.export_power = pyo.Constraint(model.q, rule=lambda m, q: m.export[q] <= export_limit)
    model.soc_step = pyo.Constraint(model.q, rule=lambda m, q: m.soc[q + 1] == m.soc[q] + DURATION * (
        eta * m.charge[q] - m.discharge[q] / eta))
    if battery.maxCyclesPerDay is not None:
        limit = capacity * battery.maxCyclesPerDay
        model.charged_limit = pyo.Constraint(expr=DURATION * eta * sum(model.charge.values()) <= limit)
        model.discharged_limit = pyo.Constraint(expr=DURATION / eta * sum(model.discharge.values()) <= limit)
    if market == "daa" and data.product_minutes == 60:
        model.hourly_commitment = pyo.Constraint(model.q, rule=lambda m, q: m.net[q] == m.net[q - q % 4]
                                                 if q % 4 else pyo.Constraint.Skip)
    wear_rate = battery.wearCostPerMWh * DURATION / eta
    model.wear = pyo.Expression(expr=wear_rate * sum(model.discharge.values()))
    model.objective = pyo.Objective(expr=sum(DURATION * data.prices[q] * (model.net[q] - float(previous[q]))
                                              for q in model.q) - model.wear + previous_wear,
                                      sense=pyo.maximize)
    result = solver.solve(model, timelimit=30, load_solutions=False)
    if result.solver.status != SolverStatus.ok or result.solver.termination_condition != TerminationCondition.optimal:
        raise CalculationError(f"GLPK did not finish optimally: {result.solver.termination_condition}.")
    model.solutions.load_from(result)

    def values(component):
        return np.array([pyo.value(value) for value in component.values()])

    pv_charge, pv_export = values(model.pv_to_battery), values(model.pv_export)
    grid, discharge, soc = values(model.grid_to_battery), values(model.discharge), values(model.soc)
    charge, export = pv_charge + grid, pv_export + discharge
    net = export - grid
    tol = 1e-6
    if (not np.isfinite(np.r_[pv_charge, pv_export, grid, discharge, soc]).all()
            or (np.r_[pv_charge, pv_export, grid, discharge, soc] < -tol).any()
            or (pv_charge + pv_export > pv + tol).any() or (grid > grid_limit + tol).any()
            or (export > export_limit + tol).any() or (np.minimum(grid, export) > tol).any()
            or (charge > pmax + tol).any() or (discharge > pmax + tol).any()
            or (np.minimum(charge, discharge) > tol).any() or (soc > capacity + tol).any()
            or abs(soc[0]) > tol or abs(soc[-1]) > tol
            or (abs(np.diff(soc) - DURATION * (eta * charge - discharge / eta)) > tol).any()):
        raise CalculationError("Hybrid physical flows, limits or state of charge did not reconcile.")
    if battery.maxCyclesPerDay is not None and max(charge.sum() * eta, discharge.sum() / eta) * DURATION > limit + tol:
        raise CalculationError("Hybrid daily throughput did not reconcile.")
    if market == "daa" and data.product_minutes == 60 and (abs(net - np.repeat(net[::4], 4)) > tol).any():
        raise CalculationError("Hybrid day-ahead hourly commitment did not reconcile.")
    delta = net - previous
    buy, sell = np.maximum(-delta, 0), np.maximum(delta, 0)
    buy_close, sell_close = np.minimum(buy, np.maximum(previous, 0)), np.minimum(sell, np.maximum(-previous, 0))
    revenue = DURATION * delta * np.asarray(data.prices)
    wear = float(wear_rate * discharge.sum())
    gross = float(revenue.sum())
    close(gross - wear + previous_wear, pyo.value(model.objective),
          1e-5 + 1e-7 * abs(gross), "hybrid stage cash flow")
    return dict(net=net, wear=wear, pvCharge=pv_charge, pvExport=pv_export, gridCharge=grid, discharge=discharge,
                export=export, soc=soc, curtail=np.maximum(pv - pv_charge - pv_export, 0), gross=gross,
                trade=dict(price=data.prices, buy=buy - buy_close, sell=sell - sell_close, buyToClose=buy_close,
                           sellToClose=sell_close, revenue=revenue))


def hybrid_day(request, markets, pv, solver, day, detail=False):
    previous, wear = np.zeros(len(pv)), 0.
    stages = {}
    for market in MARKETS:
        try:
            stage = solve_hybrid_stage(request, market, markets[market], pv, previous, wear, solver)
        except Exception as exc:
            raise CalculationError(f"{day} / {market.upper()}: {exc}") from exc
        previous, wear = stage["net"], stage["wear"]
        stages[market] = stage
    totals = {market: stage["gross"] for market, stage in stages.items()}
    final = stages[MARKETS[-1]]
    metrics = dict(marketRevenue=totals, gross=sum(totals.values()), wear=wear,
                   margin=sum(totals.values()) - wear, pvMWh=float(pv.sum() * DURATION))
    for flow in ("pvCharge", "pvExport", "gridCharge", "discharge", "export", "curtail"):
        metrics[flow + "MWh"] = float(final[flow].sum() * DURATION)
    if not detail:
        return metrics
    start = datetime.fromisoformat(day).replace(tzinfo=ZoneInfo("Europe/Prague")).astimezone(UTC)
    rows = []
    for i in range(len(pv)):
        row = dict(datetime=(start + i * QUARTER).isoformat(), pvMW=float(pv[i]), socMWh=float(final["soc"][i + 1]))
        row.update({flow + "MW": float(final[flow][i]) for flow in ("pvCharge", "pvExport", "gridCharge",
                                                                  "discharge", "export", "curtail")})
        for market, stage in stages.items():
            row.update({f"{market}_{field}": float(values[i]) for field, values in stage["trade"].items()})
        rows.append(row)
    return {"metrics": metrics, "rows": rows}


def new_solver():
    solver_info()
    return pyo.SolverFactory("glpk", executable=solver_path())


def run_hybrid(request, study, catalog, scenarios, coverage, progress):
    solver, zone = new_solver(), ZoneInfo(study.timezone)
    complete = 0
    results = []
    for year, keys in scenarios.items():
        result = {"year": year, "dates": list(keys), "marketRevenue": dict.fromkeys(MARKETS, 0.)}
        for key in keys:
            pv = pv_quarters(catalog, request, year, key, zone)
            daily = hybrid_day(request, study.days[key], pv, solver, key)
            for metric, value in daily.items():
                if metric == "marketRevenue":
                    for market, revenue in value.items():
                        result[metric][market] += revenue
                else:
                    result[metric] = result.get(metric, 0.) + value
            complete += 1
            progress({"completed": complete, "current": f"{year} · {key}"})
        results.append(result)
    return {"years": results, "coverage": coverage, "mode": request.studyMode,
            "setup": request.model_dump(exclude={"studyId", "priceYear"}),
            "priceYear": int(coverage[0]["firstDate"][:4]) if request.studyMode == "weather" else None,
            "margin": stats([result["margin"] for result in results])}
