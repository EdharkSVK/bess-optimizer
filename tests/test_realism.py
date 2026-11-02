"""Adversarial feasibility checks against the actual upstream Pyomo models."""
import math
import random

import pyomo.environ as pyo
import pytest
from pyomo.opt import TerminationCondition

from optimizer import optimizer as Original
from backend import engine
from backend.domain import Battery, MarketDay, make_study


class CapturedModel(Exception):
    def __init__(self, model):
        self.model = model


class ModelOnly(Original):
    def set_glpk_solver(self):
        class Capture:
            def solve(self, model, **kwargs):
                raise CapturedModel(model)
        return Capture()


def assemble(ctx, adapt=True):
    original = ModelOnly(engine.solver_path())
    args = dict(n_cycles=ctx.battery.maxCyclesPerDay, energy_cap=ctx.battery.capacityMWh,
                power_cap=ctx.battery.maxPowerMW)
    with pytest.raises(CapturedModel) as captured:
        if ctx.market == "daa":
            original.step1_optimize_daa(**args, daa_price_vector=list(ctx.data.prices))
        elif ctx.market == "ida":
            original.step2_optimize_ida(**args, ida_price_vector=list(ctx.data.prices),
                step1_cha_daa=list(ctx.previous_charge), step1_dis_daa=list(ctx.previous_discharge))
        else:
            original.step3_optimize_idc(**args, idc_price_vector=list(ctx.data.prices),
                step2_cha_daaida=list(ctx.previous_charge), step2_dis_daaida=list(ctx.previous_discharge))
    model = captured.value.model
    if adapt:
        engine.adapt_model(model, ctx)
    return model


def termination(model):
    return pyo.SolverFactory("glpk", executable=engine.solver_path()).solve(
        model, load_solutions=False, timelimit=30).solver.termination_condition


@pytest.mark.parametrize("market", ["daa", "ida", "idc"])
@pytest.mark.parametrize("efficiency", [1., .85])
def test_simultaneous_physical_flow_is_infeasible_at_every_efficiency(market, efficiency):
    b = Battery(wearCostPerMWh=0, capacityMWh=1, maxPowerMW=1, roundtripEfficiency=efficiency, maxCyclesPerDay=1)
    ctx = engine.StageContext(market, b, MarketDay((0.,)*96, 60 if market == "daa" else 15), (0.,)*96, (0.,)*96)
    model = assemble(ctx)
    for q in model.Q:
        getattr(model, f"cha_{market}")[q].fix(1 if q <= 4 else 0)
        # Balanced SOC even with losses: without direction guards this is feasible.
        getattr(model, f"dis_{market}")[q].fix(efficiency if q <= 4 else 0)
        if market != "daa":
            getattr(model, f"cha_{market}_close")[q].fix(0)
            getattr(model, f"dis_{market}_close")[q].fix(0)
    assert termination(model) == TerminationCondition.infeasible
    for name in ("physical_charge_direction", "physical_discharge_direction", "trade_buy_direction", "trade_sell_direction"):
        if hasattr(model, name):
            getattr(model, name).deactivate()
    assert termination(model) == TerminationCondition.optimal


@pytest.mark.parametrize("market", ["ida", "idc"])
@pytest.mark.parametrize("efficiency", [1., .85])
def test_same_market_cancel_and_reopen_churn_is_infeasible(market, efficiency):
    b = Battery(wearCostPerMWh=0, capacityMWh=1, maxPowerMW=1, roundtripEfficiency=efficiency, maxCyclesPerDay=1)
    previous_c = tuple(.5 if i < 4 else 0. for i in range(96))
    previous_d = tuple(.5 * efficiency if i >= 92 else 0. for i in range(96))
    ctx = engine.StageContext(market, b, MarketDay((0.,)*96, 15), previous_c, previous_d)
    model = assemble(ctx)
    for q in model.Q:
        getattr(model, f"cha_{market}")[q].fix(.5 if q <= 4 else 0)
        getattr(model, f"dis_{market}_close")[q].fix(.5 if q <= 4 else 0)
        getattr(model, f"dis_{market}")[q].fix(0)
        getattr(model, f"cha_{market}_close")[q].fix(0)
    assert termination(model) == TerminationCondition.infeasible
    model.trade_buy_direction.deactivate()
    model.trade_sell_direction.deactivate()
    assert termination(model) == TerminationCondition.optimal


@pytest.mark.parametrize("market", ["ida", "idc"])
def test_financial_two_power_reversal_is_allowed_without_physical_overload(market):
    b = Battery(wearCostPerMWh=0, capacityMWh=1, maxPowerMW=1, roundtripEfficiency=1, maxCyclesPerDay=1)
    previous_c = (1., 1.) + (0.,)*94
    previous_d = (0., 0., 1., 1.) + (0.,)*92
    ctx = engine.StageContext(market, b, MarketDay((0.,)*96, 15), previous_c, previous_d)
    model = assemble(ctx)
    for q in model.Q:
        getattr(model, f"cha_{market}")[q].fix(1 if q == 3 else 0)
        getattr(model, f"cha_{market}_close")[q].fix(1 if q == 3 else 0)
        getattr(model, f"dis_{market}")[q].fix(1 if q == 2 else 0)
        getattr(model, f"dis_{market}_close")[q].fix(1 if q == 2 else 0)
    solver = pyo.SolverFactory("glpk", executable=engine.solver_path())
    result = solver.solve(model, timelimit=30)
    assert result.solver.termination_condition == TerminationCondition.optimal
    stage = engine.capture_and_validate(model, ctx)
    assert stage["sell"][1] + stage["sellClose"][1] == 2
    assert stage["buy"][2] + stage["buyClose"][2] == 2
    assert stage["discharge"][1] == stage["charge"][2] == 1


@pytest.mark.parametrize("efficiency", [1., .85])
def test_cannot_sell_future_energy_before_it_is_charged(csv_prices, efficiency):
    study = make_study({"idc": ("high-before-low.csv", csv_prices(prices=[100]*48 + [10]*48))})
    result = engine.optimize(study, Battery(wearCostPerMWh=0, maxCyclesPerDay=1.5, roundtripEfficiency=efficiency))
    assert result["totalRevenue"] == pytest.approx(0)
    assert result["cycles"] == pytest.approx(0)


@pytest.mark.parametrize("seed,efficiency", [(1, 1.), (2, .85), (3, .5), (4, .99)])
def test_random_prices_reconcile_raw_positions_and_limits(csv_prices, seed, efficiency):
    rng = random.Random(seed)
    files = {m: (m, csv_prices(prices=[rng.randint(-60, 160) for _ in range(96)])) for m in ("daa", "ida", "idc")}
    battery = Battery(wearCostPerMWh=0, capacityMWh=.5, maxPowerMW=2, roundtripEfficiency=efficiency, maxCyclesPerDay=1.25)
    result = engine.optimize(make_study(files), battery)
    eta = math.sqrt(efficiency)
    for row in result["daily"][0]["schedule"]:
        c = d = 0.
        for trade in row["trades"].values():
            assert min(trade["buyMW"] + trade["buyToCloseMW"], trade["sellMW"] + trade["sellToCloseMW"]) <= 1e-7
            c += trade["buyMW"] - trade["sellToCloseMW"]
            d += trade["sellMW"] - trade["buyToCloseMW"]
            assert min(c, d) <= 1e-7
            assert min(c, d) >= -1e-7
            assert max(c, d) <= battery.maxPowerMW + 1e-7
        assert row["chargeMW"] == pytest.approx(c, abs=1e-7)
        assert row["dischargeMW"] == pytest.approx(d, abs=1e-7)
        assert row["socEndMWh"] == pytest.approx(row["socStartMWh"] + .25 * (eta*c - d/eta), abs=1e-7)
        assert -1e-7 <= row["socEndMWh"] <= battery.capacityMWh + 1e-7
    assert result["cycles"] <= battery.maxCyclesPerDay + 1e-7


def test_independent_checker_rejects_overlap_even_if_direction_guard_is_disabled():
    ctx = engine.StageContext("daa", Battery(wearCostPerMWh=0, maxCyclesPerDay=1.5, capacityMWh=1, roundtripEfficiency=1),
                              MarketDay((0.,)*96, 60), (0.,)*96, (0.,)*96)
    model = assemble(ctx)
    model.physical_charge_direction.deactivate()
    model.physical_discharge_direction.deactivate()
    for q in model.Q:
        model.cha_daa[q].fix(1 if q <= 4 else 0)
        model.dis_daa[q].fix(1 if q <= 4 else 0)
        model.physical_direction[q].fix(0)
    result = pyo.SolverFactory("glpk", executable=engine.solver_path()).solve(model)
    assert result.solver.termination_condition == TerminationCondition.optimal
    with pytest.raises(engine.CalculationError, match="Simultaneous physical"):
        engine.capture_and_validate(model, ctx)


def test_large_capacity_cannot_relax_normalized_power_tolerance():
    ctx = engine.StageContext("daa", Battery(wearCostPerMWh=0, maxCyclesPerDay=1.5, capacityMWh=1e9, maxPowerMW=1, roundtripEfficiency=1),
                              MarketDay((0.,)*96, 60), (0.,)*96, (0.,)*96)
    model = assemble(ctx)
    for var in model.component_data_objects(pyo.Var):
        var.set_value(0)
    # This exceeds the grid power by 0.01%, irrespective of energy capacity.
    model.cha_daa[1].set_value(1.0001, skip_validation=True)
    with pytest.raises(engine.CalculationError, match="Variable bound failed"):
        engine.capture_and_validate(model, ctx)


@pytest.mark.parametrize("market", ["daa", "ida", "idc"])
def test_lossless_stage_objective_matches_upstream_for_same_incoming_positions(market):
    rng = random.Random(42)
    prices = (tuple(p for _ in range(24) for p in [rng.randint(-50, 150)]*4)
              if market == "daa" else tuple(rng.randint(-50, 150) for _ in range(96)))
    previous_c = tuple(.5 if i < 4 else 0. for i in range(96)) if market != "daa" else (0.,)*96
    previous_d = tuple(.5 if i >= 92 else 0. for i in range(96)) if market != "daa" else (0.,)*96
    ctx = engine.StageContext(market, Battery(wearCostPerMWh=0, maxCyclesPerDay=1.5, capacityMWh=1, roundtripEfficiency=1),
                              MarketDay(prices, 60 if market == "daa" else 15), previous_c, previous_d)
    original = assemble(ctx, adapt=False)
    result = pyo.SolverFactory("glpk", executable=engine.solver_path()).solve(original, timelimit=30)
    assert result.solver.termination_condition == TerminationCondition.optimal
    checked = engine.solve_stage(ctx, engine.solver_path())
    assert checked["totalRevenue"] == pytest.approx(pyo.value(original.obj), abs=1e-6)


def test_daily_empty_boundary_deliberately_excludes_overnight_arbitrage(csv_prices):
    first = csv_prices(day="2025-01-01", prices=[10])
    second = csv_prices(day="2025-01-02", prices=[100])
    data = first + second.split(b"\n", 1)[1]
    result = engine.optimize(make_study({"idc": ("overnight.csv", data)}),
                             Battery(wearCostPerMWh=0, maxCyclesPerDay=1.5, capacityMWh=1, maxPowerMW=1, roundtripEfficiency=1))
    assert len(result["daily"]) == 2
    # Carrying 1 MWh overnight could earn EUR 90, but that is outside this model.
    assert result["totalRevenue"] == pytest.approx(0)
    for day in result["daily"]:
        assert day["schedule"][0]["socStartMWh"] == pytest.approx(0)
        assert day["schedule"][-1]["socEndMWh"] == pytest.approx(0)
