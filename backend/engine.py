"""Use upstream stage methods; adapt only their constructed Pyomo constraints."""
from __future__ import annotations

import hashlib
import json
import math
import os
import shutil
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Callable
from zoneinfo import ZoneInfo

import pyomo.environ as pyo
from pyomo.opt import SolverStatus, TerminationCondition

from optimizer import optimizer as UpstreamOptimizer
from .domain import Battery, MARKETS, MarketDay, Study

ROOT = Path(__file__).resolve().parent.parent
PROVENANCE = json.loads((ROOT / "backend/provenance.json").read_text())
POSITION_TOL = 1e-7
ENERGY_CONSTRAINTS = {
    "set_maximum_soc", "set_minimum_soc", "set_first_soc_to_0", "set_last_soc_to_0",
    "soc_step_constraint", "charge_cycle_limit", "discharge_cycle_limit",
}


class CalculationError(RuntimeError):
    pass


def solver_path():
    return os.environ.get("GLPSOL_PATH") or shutil.which("glpsol")


def solver_info():
    actual_hash = hashlib.sha256((ROOT / "optimizer.py").read_bytes()).hexdigest()
    if actual_hash != PROVENANCE["sha256"]:
        raise CalculationError("Upstream optimizer fingerprint differs from the reviewed source.")
    path = solver_path()
    if not path:
        raise CalculationError("GLPK executable not found. Run the Docker app or set GLPSOL_PATH.")
    solver = pyo.SolverFactory("glpk", executable=path)
    if not solver.available(exception_flag=False):
        raise CalculationError("GLPK is not executable.")
    return {"name": "GLPK", "version": ".".join(map(str, solver.version())), "sourceSha256": actual_hash}


@dataclass(frozen=True)
class StageContext:
    market: str
    battery: Battery
    data: MarketDay
    previous_charge: tuple[float, ...]
    previous_discharge: tuple[float, ...]


def physical_expressions(model, ctx: StageContext):
    """Normalized physical positions AFTER closing earlier financial positions."""
    charge = getattr(model, f"cha_{ctx.market}")
    discharge = getattr(model, f"dis_{ctx.market}")
    if ctx.market == "daa":
        return ({q: charge[q] for q in model.Q}, {q: discharge[q] for q in model.Q})
    buy_close = getattr(model, f"cha_{ctx.market}_close")
    sell_close = getattr(model, f"dis_{ctx.market}_close")
    return (
        {q: ctx.previous_charge[q - 1] - sell_close[q] + charge[q] for q in model.Q},
        {q: ctx.previous_discharge[q - 1] - buy_close[q] + discharge[q] for q in model.Q},
    )


def adapt_model(model, ctx: StageContext):
    if ctx.market == "daa" and ctx.data.product_minutes == 15:
        for direction in ("cha", "dis"):
            for pair in ("1_2", "2_3", "3_4"):
                getattr(model, f"{direction}_daa_quarters_{pair}_parity").deactivate()
    eta = math.sqrt(ctx.battery.roundtripEfficiency)
    energy = ctx.battery.maxPowerMW / 4
    cap = ctx.battery.maxCyclesPerDay
    charge, discharge = physical_expressions(model, ctx)
    if ctx.battery.roundtripEfficiency < 1:
        for q in model.Q:
            model.soc_step_constraint[q].set_value(
                model.soc[q + 1] == model.soc[q] + energy * (eta * charge[q] - discharge[q] / eta))
        if cap is not None:
            limit = ctx.battery.capacityMWh * cap
            model.charge_cycle_limit.set_value(energy * eta * sum(charge.values()) <= limit)
            model.discharge_cycle_limit.set_value(energy / eta * sum(discharge.values()) <= limit)
    if cap is None:
        model.charge_cycle_limit.deactivate()
        model.discharge_cycle_limit.deactivate()
    if ctx.battery.wearCostPerMWh:
        # Each stage revises a planned schedule; no energy has been dispatched
        # by these model stages. Penalize the CHANGE in physical wear so keeping
        # incoming positions has zero incremental value, and closures can save wear.
        wear_after = ctx.battery.wearCostPerMWh * energy / eta * sum(discharge.values())
        wear_before = ctx.battery.wearCostPerMWh * energy / eta * sum(ctx.previous_discharge)
        model.obj.set_value(model.obj.expr - wear_after + wear_before)
    # Physical direction is mandatory even at 100% efficiency. Do not net away
    # infeasible gross flows later to obtain an apparently plausible schedule.
    model.physical_direction = pyo.Var(model.Q, domain=pyo.Binary)
    model.physical_charge_direction = pyo.Constraint(
        model.Q, rule=lambda m, q: charge[q] <= m.physical_direction[q])
    model.physical_discharge_direction = pyo.Constraint(
        model.Q, rule=lambda m, q: discharge[q] <= 1 - m.physical_direction[q])
    if ctx.market != "daa":
        # One clearing price per interval/stage: buying and selling in that same
        # stage is pointless churn. This does NOT prevent closing an earlier
        # market position. A full reversal legitimately requires up to 2*P of
        # financial trades while the resulting physical power stays <= P.
        buy = getattr(model, f"cha_{ctx.market}")
        sell = getattr(model, f"dis_{ctx.market}")
        buy_close = getattr(model, f"cha_{ctx.market}_close")
        sell_close = getattr(model, f"dis_{ctx.market}_close")
        model.trade_direction = pyo.Var(model.Q, domain=pyo.Binary)
        model.trade_buy_direction = pyo.Constraint(model.Q, rule=lambda m, q:
            buy[q] + buy_close[q] <= (1 + ctx.previous_discharge[q - 1]) * m.trade_direction[q])
        model.trade_sell_direction = pyo.Constraint(model.Q, rule=lambda m, q:
            sell[q] + sell_close[q] <= (1 + ctx.previous_charge[q - 1]) * (1 - m.trade_direction[q]))


def close(a, b, tolerance, message):
    if not math.isfinite(a) or not math.isfinite(b) or abs(a - b) > tolerance:
        raise CalculationError(f"Reconciliation failed: {message} ({a} versus {b}).")


def capture_and_validate(model, ctx: StageContext):
    b = ctx.battery
    tolerance = 1e-7 * max(1, b.capacityMWh)
    volume_tolerance = 1e-7 * max(1, b.capacityMWh * (b.maxCyclesPerDay if b.maxCyclesPerDay is not None else 1))
    # Also check every original and adapted constraint, not just reported KPIs.
    for var in model.component_data_objects(pyo.Var, active=True):
        value = pyo.value(var)
        if not math.isfinite(value):
            raise CalculationError(f"Non-finite solution variable: {var.name}.")
        bound_tolerance = POSITION_TOL * max(1,
            abs(pyo.value(var.lb)) if var.has_lb() else 0,
            abs(pyo.value(var.ub)) if var.has_ub() else 0)
        if (var.has_lb() and value < pyo.value(var.lb) - bound_tolerance) or (
            var.has_ub() and value > pyo.value(var.ub) + bound_tolerance
        ):
            raise CalculationError(f"Variable bound failed: {var.name}.")
        if var.is_binary():
            close(value, round(value), 1e-6, f"binary variable {var.name}")
    for constraint in model.component_data_objects(pyo.Constraint, active=True):
        value = pyo.value(constraint.body)
        component = constraint.parent_component().local_name
        constraint_tolerance = (volume_tolerance if component.endswith("cycle_limit") else tolerance) if component in ENERGY_CONSTRAINTS else POSITION_TOL
        if not math.isfinite(value) or (
            constraint.has_lb() and value < pyo.value(constraint.lower) - constraint_tolerance
        ) or (constraint.has_ub() and value > pyo.value(constraint.upper) + constraint_tolerance):
            raise CalculationError(f"Constraint failed: {constraint.name}.")
    c_expr, d_expr = physical_expressions(model, ctx)
    combined_c = [float(pyo.value(c_expr[q])) for q in model.Q]
    combined_d = [float(pyo.value(d_expr[q])) for q in model.Q]
    soc = [float(pyo.value(model.soc[q])) for q in model.Q_plus_1]
    values = lambda name: [float(pyo.value(v)) for v in getattr(model, name).values()]
    buy, sell = values(f"cha_{ctx.market}"), values(f"dis_{ctx.market}")
    buy_close = values(f"cha_{ctx.market}_close") if ctx.market != "daa" else [0.] * 96
    sell_close = values(f"dis_{ctx.market}_close") if ctx.market != "daa" else [0.] * 96
    eta = math.sqrt(b.roundtripEfficiency)
    close(soc[0], 0, tolerance, "initial SOC")
    close(soc[-1], 0, tolerance, "terminal SOC")
    if min(soc) < -tolerance or max(soc) > b.capacityMWh + tolerance:
        raise CalculationError("SOC outside usable energy capacity.")
    for i, (c, d) in enumerate(zip(combined_c, combined_d)):
        close(soc[i + 1], soc[i] + b.maxPowerMW / 4 * (eta * c - d / eta), tolerance, f"SOC interval {i}")
        if min(c, d) < -POSITION_TOL or max(c, d) > 1 + POSITION_TOL:
            raise CalculationError("Combined physical power outside bounds.")
        if min(c, d) > POSITION_TOL:
            raise CalculationError("Simultaneous physical charging/discharging.")
        if buy_close[i] > ctx.previous_discharge[i] + POSITION_TOL or sell_close[i] > ctx.previous_charge[i] + POSITION_TOL:
            raise CalculationError("Closing trade exceeds previous position.")
        if min(buy[i] + buy_close[i], sell[i] + sell_close[i]) > POSITION_TOL:
            raise CalculationError("Offsetting buys and sells within the same market stage.")
    if ctx.market == "daa" and ctx.data.product_minutes == 60:
        for i in range(0, 96, 4):
            for j in range(i + 1, i + 4):
                close(buy[j], buy[i], POSITION_TOL, "hourly DA buy block")
                close(sell[j], sell[i], POSITION_TOL, "hourly DA sell block")
    internal_discharge = sum(combined_d) * b.maxPowerMW / 4 / eta
    if b.maxCyclesPerDay is not None and max(sum(combined_c) * b.maxPowerMW / 4 * eta,
           internal_discharge) > b.capacityMWh * b.maxCyclesPerDay + volume_tolerance:
        raise CalculationError("Internal throughput exceeds the daily cycle budget.")
    revenue = [b.maxPowerMW / 4 * price * (s + sc - c - bc)
               for price, s, sc, c, bc in zip(ctx.data.prices, sell, sell_close, buy, buy_close)]
    wear_cost = internal_discharge * b.wearCostPerMWh
    previous_wear = sum(ctx.previous_discharge) * b.maxPowerMW / 4 / eta * b.wearCostPerMWh
    wear_change = wear_cost - previous_wear
    objective = float(pyo.value(model.obj))
    cash_tolerance = 1e-5 + 1e-7 * (sum(abs(r) for r in revenue) + wear_cost + previous_wear)
    close(sum(revenue) - wear_change, objective, cash_tolerance, "stage wear-adjusted objective")
    if objective < -cash_tolerance:
        raise CalculationError("Stage wear-adjusted gain is negative although keeping previous positions is feasible.")
    return {
        "buy": buy, "sell": sell, "buyClose": buy_close, "sellClose": sell_close,
        "charge": combined_c, "discharge": combined_d, "soc": soc,
        "revenue": revenue, "totalRevenue": sum(revenue), "wearCost": wear_cost,
        "wearCostChange": wear_change, "wearAdjustedGain": objective,
        "internalDischargedMWh": internal_discharge, "solverStatus": "optimal",
    }


class CheckedSolver:
    def __init__(self, owner, solver):
        self.owner, self.solver = owner, solver

    def solve(self, model, **kwargs):
        adapt_model(model, self.owner.context)
        kwargs.update(timelimit=30, load_solutions=False)
        results = self.solver.solve(model, **kwargs)
        if results.solver.status != SolverStatus.ok or results.solver.termination_condition != TerminationCondition.optimal:
            raise CalculationError(f"GLPK did not finish optimally: {results.solver.termination_condition}.")
        model.solutions.load_from(results)
        self.owner.captured = capture_and_validate(model, self.owner.context)
        return results


class CheckedOptimizer(UpstreamOptimizer):
    def __init__(self, context: StageContext, path: str):
        super().__init__(solverpath_exe=path)
        self.context = context
        self.captured = None

    def set_glpk_solver(self):
        return CheckedSolver(self, super().set_glpk_solver())


def solve_stage(ctx: StageContext, path: str):
    engine = CheckedOptimizer(ctx, path)
    # Upstream requires a numeric value; the adapter deactivates this placeholder
    # budget when no contractual cap is configured.
    args = dict(n_cycles=ctx.battery.maxCyclesPerDay or 0., energy_cap=ctx.battery.capacityMWh,
                power_cap=ctx.battery.maxPowerMW)
    if ctx.market == "daa":
        original = engine.step1_optimize_daa(**args, daa_price_vector=list(ctx.data.prices))
    elif ctx.market == "ida":
        original = engine.step2_optimize_ida(**args, ida_price_vector=list(ctx.data.prices),
            step1_cha_daa=list(ctx.previous_charge), step1_dis_daa=list(ctx.previous_discharge))
    else:
        original = engine.step3_optimize_idc(**args, idc_price_vector=list(ctx.data.prices),
            step2_cha_daaida=list(ctx.previous_charge), step2_dis_daaida=list(ctx.previous_discharge))
    stage = engine.captured
    close(float(original[3 if ctx.market == "daa" else 5]), stage["totalRevenue"],
          1e-5 + 1e-7 * abs(stage["totalRevenue"]), "upstream returned revenue")
    # Retain the actual upstream returned positions, at full precision, for handoff.
    c, d = (original[1], original[2]) if ctx.market == "daa" else (original[6], original[7])
    for actual, expected in zip(list(c) + list(d), stage["charge"] + stage["discharge"]):
        close(float(actual), expected, 1e-6, "upstream combined positions")
    stage["charge"], stage["discharge"] = list(map(float, c)), list(map(float, d))
    return stage


def optimize(study: Study, battery: Battery, progress: Callable[[dict], None] = lambda _: None):
    info = solver_info()
    path = solver_path()
    daily = []
    totals = {m: 0. if m in study.preview["markets"] else None for m in MARKETS}
    for day_index, (day, markets) in enumerate(study.days.items()):
        previous_c = previous_d = (0.,) * 96
        stages = {}
        for market in MARKETS:
            if market not in markets:
                continue
            progress({"completedDays": day_index, "currentDate": day, "currentMarket": market})
            try:
                ctx = StageContext(market, battery, markets[market], previous_c, previous_d)
                stage = solve_stage(ctx, path)
            except Exception as exc:
                raise CalculationError(f"{day} / {market.upper()}: {exc}") from exc
            stages[market] = stage
            totals[market] += stage["totalRevenue"]
            previous_c, previous_d = tuple(stage["charge"]), tuple(stage["discharge"])
        final = stages[next(reversed(stages))]
        start = datetime.fromisoformat(day).replace(tzinfo=ZoneInfo(study.timezone))
        schedule = []
        cycles = 0.
        for i in range(96):
            # Publish validated physical legs, not a net that could conceal
            # simultaneous gross charging/discharging. Clip only negative noise.
            charge = max(battery.maxPowerMW * previous_c[i], 0.)
            discharge = max(battery.maxPowerMW * previous_d[i], 0.)
            internal_discharge = discharge / 4 / math.sqrt(battery.roundtripEfficiency)
            interval_cycles = internal_discharge / battery.capacityMWh
            wear_cost = internal_discharge * battery.wearCostPerMWh
            cycles += interval_cycles
            trades = {m: {
                "price": markets[m].prices[i], "buyMW": s["buy"][i] * battery.maxPowerMW,
                "sellMW": s["sell"][i] * battery.maxPowerMW,
                "buyToCloseMW": s["buyClose"][i] * battery.maxPowerMW,
                "sellToCloseMW": s["sellClose"][i] * battery.maxPowerMW,
                "revenue": s["revenue"][i],
            } for m, s in stages.items()}
            interval_revenue = sum(t["revenue"] for t in trades.values())
            schedule.append({"datetime": (start + timedelta(minutes=15 * i)).isoformat(),
                "chargeMW": charge, "dischargeMW": discharge,
                "socStartMWh": final["soc"][i], "socEndMWh": final["soc"][i + 1],
                "trades": trades, "revenue": interval_revenue,
                "internalDischargedMWh": internal_discharge, "cycles": interval_cycles,
                "wearCost": wear_cost, "wearAdjustedMargin": interval_revenue - wear_cost})
        revenues = {m: stages[m]["totalRevenue"] if m in stages else None for m in MARKETS}
        day_total = sum(v for v in revenues.values() if v is not None)
        close(sum(r["revenue"] for r in schedule), day_total, 1e-5 + 1e-7 * abs(day_total), "daily revenue")
        day_wear = sum(r["wearCost"] for r in schedule)
        day_margin = day_total - day_wear
        close(sum(s["wearCostChange"] for s in stages.values()), day_wear,
              1e-5 + 1e-7 * abs(day_wear), "wear changes telescope to final physical wear")
        close(sum(s["wearAdjustedGain"] for s in stages.values()), day_margin,
              1e-5 + 1e-7 * abs(day_margin), "stage gains reconcile to daily wear-adjusted margin")
        daily.append({"date": day, "marketRevenue": revenues, "totalRevenue": day_total,
            "cycles": cycles, "averageCyclesPerDay": cycles, "schedule": schedule,
            "internalDischargedMWh": sum(r["internalDischargedMWh"] for r in schedule),
            "wearCost": day_wear, "wearAdjustedMargin": day_margin,
            "stages": {m: {"socBoundariesMWh": s["soc"], "solverStatus": s["solverStatus"],
                "wearCostChange": s["wearCostChange"], "wearAdjustedGain": s["wearAdjustedGain"]} for m, s in stages.items()},
            "dayAheadProductMinutes": markets["daa"].product_minutes if "daa" in markets else None})
        progress({"completedDays": day_index + 1, "currentDate": day, "currentMarket": None})
    total = sum(v for v in totals.values() if v is not None)
    close(sum(d["totalRevenue"] for d in daily), total, 1e-5 + 1e-7 * abs(total), "study revenue")
    total_cycles = sum(d["cycles"] for d in daily)
    total_wear = sum(d["wearCost"] for d in daily)
    return {"marketRevenue": totals, "totalRevenue": total, "cycles": sum(d["cycles"] for d in daily),
        "wearCost": total_wear, "wearAdjustedMargin": total - total_wear,
        "internalDischargedMWh": sum(d["internalDischargedMWh"] for d in daily),
        "averageCyclesPerDay": total_cycles / len(daily) if daily else None,
        "daily": daily, "coverage": study.preview, "metadata": {
            **PROVENANCE, "solver": info, "battery": battery.model_dump(),
            "timezone": study.timezone, "stageOrder": [m for m in MARKETS if m in totals and totals[m] is not None],
            "assumptions": ["Empty start/end each day; no energy carried across midnight",
                "Perfect foresight within each selected stage; sequential rather than joint market optimization",
                "Equal earlier-stage optima can lead to different later-stage revenues",
                "No fees, execution simulation, market depth or annualization",
                "Wear penalty in EUR per internal discharged MWh; charged once on final physical dispatch",
                "Default EUR 20/MWh wear rate is an illustrative screening assumption, not a supplier quote",
                "Wear-adjusted margin is an economic measure before other costs, not project cash flow",
                "No daily cycle cap unless explicitly supplied; capacity, power and SOC limits always apply",
                "Cycle averages divide by modelled days, including zero-cycle days; excluded days are not zeros",
                "All input files must represent the same bidding zone and EUR/MWh",
                "Constant efficiency and usable capacity; no auxiliary consumption or capacity fade",
                "Opposite trades across stages may close positions without physical battery cycling"],
            "adaptations": {"physicalExclusivity": True, "sameStageTradeExclusivity": True,
                "efficiency": battery.roundtripEfficiency < 1,
                "quarterHourlyDayAhead": any(d["dayAheadProductMinutes"] == 15 for d in daily)},
        }}
