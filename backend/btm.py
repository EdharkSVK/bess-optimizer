"""Hourly behind-the-meter dispatch and annual scenario economics."""
from __future__ import annotations

from calendar import isleap
from datetime import timedelta
from functools import lru_cache
from math import expm1, log1p, sqrt
from typing import Literal
from zoneinfo import ZoneInfo

import numpy as np
from pydantic import BaseModel, ConfigDict, Field, model_validator
from scipy.optimize import linprog
from scipy.sparse import coo_matrix, diags, eye, hstack, vstack

from .domain import Battery
from .engine import CalculationError
from .profiles import HOUR, replay_load, year_start


class Inputs(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Size(Inputs):
    pvMWp: float = Field(gt=0)
    batteryMW: float = Field(default=0, ge=0)
    batteryMWh: float = Field(default=0, ge=0)

    @model_validator(mode="after")
    def battery_dimensions(self):
        if (self.batteryMW == 0) != (self.batteryMWh == 0):
            raise ValueError("Set both battery dimensions to zero for PV only, or both positive.")
        return self


class Costs(Inputs):
    pvCapexPerMWp: float = Field(ge=0)
    batteryCapexPerMW: float = Field(ge=0)
    batteryCapexPerMWh: float = Field(ge=0)
    pvOpexPerMWpYear: float = Field(ge=0)
    batteryOpexPerMWhYear: float = Field(ge=0)
    pvLifeYears: int = Field(gt=0, le=100)
    batteryLifeYears: int = Field(gt=0, le=100)
    discountRate: float = Field(ge=0, le=1)


class BtmRequest(Inputs):
    technology: Literal["residential", "industrial"]
    annualLoadMWh: float = Field(gt=0)
    importTariff: float = Field(ge=0)
    exportTariff: float = Field(ge=0)
    exportLimitMW: float | None = Field(default=None, ge=0)
    battery: Battery = Field(default_factory=Battery)
    mode: Literal["manual", "sizing"] = "manual"
    sizes: list[Size] = Field(min_length=1, max_length=12)
    costs: Costs | None = None
    years: list[int] | None = Field(default=None, min_length=1, max_length=10)
    sites: list[str] | None = Field(default=None, min_length=1, max_length=30)

    @model_validator(mode="after")
    def mode_inputs(self):
        if self.mode == "manual" and len(self.sizes) != 1:
            raise ValueError("Manual mode requires exactly one size.")
        if self.mode == "sizing" and self.costs is None:
            raise ValueError("Sizing requires project cost assumptions.")
        return self


def fixed_cost(size, costs):
    if costs is None:
        return 0.0, 0.0

    def recovery(life):
        rate = costs.discountRate
        return rate / -expm1(-life * log1p(rate)) if rate else 1 / life

    pv_capex = size.pvMWp * costs.pvCapexPerMWp
    battery_capex = size.batteryMW * costs.batteryCapexPerMW + size.batteryMWh * costs.batteryCapexPerMWh
    opex = size.pvMWp * costs.pvOpexPerMWpYear + size.batteryMWh * costs.batteryOpexPerMWhYear
    return pv_capex * recovery(costs.pvLifeYears) + battery_capex * recovery(costs.batteryLifeYears), opex


@lru_cache(maxsize=12)
def dispatch_matrices(year, hours, eta, daily_limit):
    identity = eye(hours, format="csr")
    soc = diags([np.ones(hours), -np.ones(hours)], [1, 0], shape=(hours, hours + 1), format="csr")
    balance = hstack([-eta * identity, identity / eta, 0 * identity, soc], format="csr")
    surplus_use = hstack([identity, 0 * identity, identity, 0 * soc], format="csr")
    if not daily_limit:
        return balance, surplus_use, None
    zone = ZoneInfo("Europe/Prague")
    days = np.array([(year_start(year) + i * HOUR).astimezone(zone).date().toordinal() for i in range(hours)])
    group = coo_matrix((np.ones(hours), (days - days[0], np.arange(hours))),
                       shape=(days[-1] - days[0] + 1, hours)).tocsr()
    zero = 0 * group
    caps = vstack([hstack([eta * group, zero, zero, hstack([zero, zero[:, :1]])]),
                   hstack([zero, group / eta, zero, hstack([zero, zero[:, :1]])])], format="csr")
    return balance, vstack([surplus_use, caps], format="csr"), group


def dispatch(year, load, pv, battery, import_tariff, export_tariff, export_limit=None):
    direct = np.minimum(load, pv)
    surplus, deficit = pv - direct, load - direct
    export_max = np.minimum(surplus, export_limit) if export_limit is not None else surplus
    hours = len(load)
    if battery is None or battery.maxCyclesPerDay == 0 or not surplus.any() or not deficit.any():
        return direct, np.zeros(hours), np.zeros(hours), export_max, np.zeros(hours + 1)
    eta = sqrt(battery.roundtripEfficiency)
    if import_tariff <= battery.wearCostPerMWh / eta:
        return direct, np.zeros(hours), np.zeros(hours), export_max, np.zeros(hours + 1)
    eq, ub, days = dispatch_matrices(year, hours, eta, battery.maxCyclesPerDay is not None)
    charge_limit = np.minimum(surplus, battery.maxPowerMW)
    discharge_limit = np.minimum(deficit, battery.maxPowerMW)
    soc_limit = np.full(hours + 1, battery.capacityMWh)
    soc_limit[[0, -1]] = 0
    cap = battery.capacityMWh * (battery.maxCyclesPerDay or 0)
    ub_rhs = np.r_[surplus, np.full(2 * days.shape[0], cap)] if days is not None else surplus
    objective = np.repeat([0, battery.wearCostPerMWh / eta - import_tariff, -export_tariff, 0],
                          [hours, hours, hours, hours + 1])
    result = linprog(objective, A_eq=eq, b_eq=np.zeros(hours), A_ub=ub, b_ub=ub_rhs,
                     bounds=np.column_stack((np.zeros(4 * hours + 1),
                                             np.r_[charge_limit, discharge_limit, export_max, soc_limit])),
                     method="highs", options={"time_limit": 60})
    if not result.success:
        raise CalculationError(f"Hourly BtM dispatch failed in {year}: {result.message}")
    charge, discharge, export, soc = np.split(result.x, [hours, 2 * hours, 3 * hours])
    # At a zero export tariff, sell all otherwise unused exportable PV.
    export = np.minimum(np.maximum(surplus - charge, 0), export_max)
    tol = 1e-6
    if (not np.isfinite(result.x).all() or min(result.x) < -tol
            or (charge > charge_limit + tol).any() or (discharge > discharge_limit + tol).any()
            or (soc > soc_limit + tol).any() or (abs(np.diff(soc) - eta * charge + discharge / eta) > tol).any()
            or (charge + export > surplus + tol).any() or (np.minimum(charge, discharge) > tol).any()
            or (days is not None and ((days @ (eta * charge) > cap + tol).any()
                                     or (days @ (discharge / eta) > cap + tol).any()))):
        raise CalculationError(f"Physical BtM dispatch did not reconcile in {year}.")
    final_cost = (battery.wearCostPerMWh / eta - import_tariff) * discharge.sum() - export_tariff * export.sum()
    if abs(final_cost - result.fun) > 1e-5 + 1e-7 * abs(result.fun):
        raise CalculationError(f"BtM cash flow did not reconcile in {year}.")
    return direct, charge, discharge, export, soc


def candidate_sizes(request):
    if request.mode == "manual":
        size = request.sizes[0]
        variants = [("PV only", Size(pvMWp=size.pvMWp))]
        if size.batteryMW:
            variants.append(("PV + BESS", size))
        return [("Grid only", None), *variants]
    return [("Grid only", None), *((f"Candidate {i + 1}", size) for i, size in enumerate(request.sizes))]


def evaluate(request, size, year, load, factor, detail=False, average_day=None, earnings_curves=None):
    pv = factor * size.pvMWp if size else np.zeros_like(load)
    battery = (request.battery.model_copy(update={"capacityMWh": size.batteryMWh, "maxPowerMW": size.batteryMW})
               if size and size.batteryMW else None)
    direct, charge, discharge, export, soc = dispatch(year, load, pv, battery, request.importTariff,
                                                      request.exportTariff, request.exportLimitMW)
    grid = np.maximum(load - direct - discharge, 0)
    curtail = np.maximum(pv - direct - charge - export, 0)
    eta = sqrt(battery.roundtripEfficiency) if battery else 1.0
    wear_rate = battery.wearCostPerMWh if battery else 0.0
    internal_discharge = discharge.sum() / eta
    wear = internal_discharge * wear_rate
    capex, opex = fixed_cost(size, request.costs) if size else (0.0, 0.0)
    baseline = request.annualLoadMWh * request.importTariff
    imported = grid.sum() if size else request.annualLoadMWh
    exported = export.sum()
    bill, receipts = imported * request.importTariff, exported * request.exportTariff
    metrics = dict(baselineBill=baseline, importCost=bill, exportReceipts=receipts, wear=wear,
                   annualizedCapex=capex, fixedOpex=opex, netSavings=baseline - bill + receipts - wear - capex - opex,
                   peakImportMW=grid.max(), peakExportMW=export.max(), importedMWh=imported,
                   exportedMWh=exported, pvMWh=pv.sum(), curtailedMWh=curtail.sum(),
                   cycles=internal_discharge / battery.capacityMWh if battery else 0.0)
    metrics = {key: float(value) for key, value in metrics.items()}
    if average_day is not None:
        for key, values in (("loadMW", load), ("pvToLoadMW", direct), ("pvChargeMW", charge),
                            ("batteryToLoadMW", discharge), ("exportMW", export)):
            # Average each complete scenario by UTC hour, then weight scenarios equally.
            average_day[key] += values.reshape(-1, 24).mean(axis=0)
    if earnings_curves is not None:
        hourly_savings = (load - grid) * request.importTariff + export * request.exportTariff - discharge * wear_rate / eta
        daily_savings = hourly_savings.reshape(-1, 24).sum(axis=1)
        cumulative = np.cumsum(daily_savings - (capex + opex) / len(daily_savings))
        # The annual result uses the requested annual load, with roundoff from hourly normalization removed.
        cumulative[-1] = metrics["netSavings"]
        earnings_curves.append(cumulative)
    if detail:
        start = year_start(year)
        return {"metrics": metrics, "rows": [
            dict(datetime=(start + hour * HOUR).isoformat(), loadMW=float(l), pvMW=float(p),
                 pvToLoadMW=float(a), pvChargeMW=float(c), batteryToLoadMW=float(d), importMW=float(g),
                 exportMW=float(e), curtailMW=float(k), socMWh=float(soc[hour + 1]))
            for hour, (l, p, a, c, d, g, e, k) in enumerate(zip(load, pv, direct, charge, discharge, grid, export, curtail))
        ]}
    return metrics


def stats(values):
    return {"mean": float(np.mean(values)), "median": float(np.median(values)),
            "min": float(np.min(values)), "max": float(np.max(values))}


def earnings_summary(curves, scenarios, years):
    anchor_year = next((year for year in years if isleap(year)), years[0])
    start = year_start(anchor_year)
    day_count = 365 + isleap(anchor_year)
    # Carry the last cumulative value through February 29 in non-leap scenarios.
    aligned = np.stack([curve if len(curve) == day_count else np.insert(curve, 59, curve[58]) for curve in curves])
    daily = [
        dict(date=(start + timedelta(days=index)).strftime("%m-%d"),
             min=float(low), median=float(middle), max=float(high))
        for index, (low, middle, high) in enumerate(zip(aligned.min(axis=0), np.median(aligned, axis=0),
                                                        aligned.max(axis=0), strict=True))
    ]
    yearly = []
    for year in years:
        values = [row["netSavings"] for row in scenarios if row["year"] == year]
        yearly.append(dict(year=year, min=min(values), median=float(np.median(values)), max=max(values)))
    return {"daily": daily, "yearly": yearly}


def run_btm(request, catalog, years, sites, progress):
    profiles = catalog.loads()
    candidates = candidate_sizes(request)
    results = [dict(label=label, size=size.model_dump() if size else None, scenarios=[]) for label, size in candidates]
    profiles_by_candidate = [
        {key: np.zeros(24) for key in ("loadMW", "pvToLoadMW", "pvChargeMW", "batteryToLoadMW", "exportMW")}
        for _ in candidates
    ]
    earnings_by_candidate = [[] for _ in candidates]
    complete = 0
    for year in years:
        factor = catalog.pv(request.technology, year)
        for site in sites:
            load = replay_load(profiles[site], year, request.annualLoadMWh)
            for index, (_, size) in enumerate(candidates):
                metrics = evaluate(request, size, year, load, factor, average_day=profiles_by_candidate[index],
                                   earnings_curves=earnings_by_candidate[index])
                results[index]["scenarios"].append(dict(year=year, site=site, **metrics))
            complete += 1
            progress({"completed": complete, "current": f"{year} · {site}"})
    for result, profile, curves in zip(results, profiles_by_candidate, earnings_by_candidate, strict=True):
        scenarios = result["scenarios"]
        result["summary"] = {metric: stats([row[metric] for row in scenarios])
                             for metric in scenarios[0] if metric not in ("year", "site")}
        result["averageDay"] = [
            {key: float(values[hour] / len(scenarios)) for key, values in profile.items()}
            for hour in range(24)
        ]
        result["earnings"] = earnings_summary(curves, scenarios, years)
    ranking = sorted(range(len(results)), key=lambda i: (-results[i]["summary"]["netSavings"]["median"],
                     results[i]["summary"]["annualizedCapex"]["mean"], i))
    return {"candidates": results, "ranking": ranking, "scenarioCount": len(years) * len(sites),
            "years": list(years), "sites": list(sites), "costsIncluded": request.costs is not None,
            "setup": request.model_dump(exclude={"sizes", "years", "sites", "battery"}),
            "battery": request.battery.model_dump(exclude={"maxPowerMW", "capacityMWh"})}
