import hashlib
import itertools
import math
from pathlib import Path
from types import SimpleNamespace

import pyomo.environ as pyo
import pytest
from pyomo.opt import SolverStatus, TerminationCondition

from optimizer import optimizer as Original
from backend import engine
from backend.domain import Battery, MARKETS, MarketDay, make_study


@pytest.fixture(autouse=True)
def require_glpk():
    if not engine.solver_path():
        pytest.fail("GLPK is required: install glpk-utils or set GLPSOL_PATH. Solver tests must not be skipped.")


def examples():
    return make_study({m: (m + ".csv", Path(f"public/examples/{m}.csv").read_bytes()) for m in MARKETS})


def test_upstream_source_fingerprint():
    assert hashlib.sha256(Path("optimizer.py").read_bytes()).hexdigest() == engine.PROVENANCE["sha256"]


def test_original_notebook_three_stage_parity(monkeypatch):
    study = examples()
    battery = Battery(wearCostPerMWh=0, capacityMWh=2, maxPowerMW=1, roundtripEfficiency=1, maxCyclesPerDay=1.5)
    prices = study.days["2025-01-01"]
    raw = Original(engine.solver_path())
    args = dict(n_cycles=1.5, energy_cap=2, power_cap=1)
    first = raw.step1_optimize_daa(**args, daa_price_vector=list(prices["daa"].prices))
    second = raw.step2_optimize_ida(**args, ida_price_vector=list(prices["ida"].prices), step1_cha_daa=first[1], step1_dis_daa=first[2])
    third = raw.step3_optimize_idc(**args, idc_price_vector=list(prices["idc"].prices), step2_cha_daaida=second[6], step2_dis_daaida=second[7])
    signatures = []
    adapt = engine.adapt_model
    def verify_unchanged(model, context):
        signature = lambda: {c.name: (c.active, str(c.expr)) for c in model.component_data_objects(pyo.Constraint)} | {"objective": str(model.obj.expr)}
        before = signature()
        adapt(model, context)
        after = signature()
        # Original lossless equations/objective remain; physical/trading safety
        # constraints are now added even at 100% efficiency.
        assert all(after[name] == expr for name, expr in before.items())
        assert hasattr(model, "physical_direction")
        signatures.append(context.market)
    monkeypatch.setattr(engine, "adapt_model", verify_unchanged)
    result = engine.optimize(study, battery)
    assert result["marketRevenue"] == pytest.approx(dict(zip(MARKETS, (first[3], second[5], third[5]))), abs=1e-6)
    assert result["totalRevenue"] == pytest.approx(first[3] + second[5] + third[5], abs=1e-6)
    assert signatures == list(MARKETS)
    for stage in result["daily"][0]["stages"].values():
        assert len(stage["socBoundariesMWh"]) == 97
        assert stage["socBoundariesMWh"][-1] == pytest.approx(0)


COMBINATIONS = [c for n in (1, 2, 3) for c in itertools.combinations(MARKETS, n)]


@pytest.mark.parametrize("selected", COMBINATIONS)
@pytest.mark.parametrize("efficiency", [1., .85])
def test_all_seven_combinations(csv_prices, selected, efficiency):
    study = make_study({m: (m + ".csv", csv_prices(minutes=60 if m == "daa" else 15)) for m in selected})
    result = engine.optimize(study, Battery(wearCostPerMWh=0, capacityMWh=1, maxPowerMW=2, roundtripEfficiency=efficiency, maxCyclesPerDay=1))
    assert set(result["daily"][0]["stages"]) == set(selected)
    assert result["totalRevenue"] == pytest.approx(sum(v for v in result["marketRevenue"].values() if v is not None))
    assert all(result["marketRevenue"][m] is None for m in MARKETS if m not in selected)
    assert result["cycles"] <= 1 + 1e-6
    for row in result["daily"][0]["schedule"]:
        assert min(row["chargeMW"], row["dischargeMW"]) == 0
        for trade in row["trades"].values():
            assert min(trade["buyMW"] + trade["buyToCloseMW"], trade["sellMW"] + trade["sellToCloseMW"]) <= 1e-7
        assert row["socEndMWh"] == pytest.approx(row["socStartMWh"] + .25 * (math.sqrt(efficiency) * row["chargeMW"] - row["dischargeMW"] / math.sqrt(efficiency)), abs=1e-6)


@pytest.mark.parametrize("efficiency,expected", [(1., 90.), (.81, 90 - 10 / .9)])
def test_hand_calculated_arbitrage(csv_prices, efficiency, expected):
    study = make_study({"daa": ("prices.csv", csv_prices(minutes=60))})
    result = engine.optimize(study, Battery(wearCostPerMWh=0, capacityMWh=1, maxPowerMW=2, roundtripEfficiency=efficiency, maxCyclesPerDay=1))
    assert result["totalRevenue"] == pytest.approx(expected, abs=1e-5)
    assert result["cycles"] == pytest.approx(1.)


def test_quarter_hourly_day_ahead_changes_only_block_constraints(csv_prices):
    data = csv_prices(prices=[0, 100, 0, 100])
    study = make_study({"daa": ("quarter.csv", data)})
    result = engine.optimize(study, Battery(wearCostPerMWh=0, capacityMWh=.25, maxPowerMW=1, roundtripEfficiency=1, maxCyclesPerDay=1))
    assert result["totalRevenue"] == pytest.approx(25)
    assert result["metadata"]["adaptations"]["quarterHourlyDayAhead"]
    hourly = make_study({"daa": ("hour.csv", csv_prices(minutes=60, prices=[0, 100]))})
    result = engine.optimize(hourly, Battery(wearCostPerMWh=0, maxCyclesPerDay=1.5, roundtripEfficiency=.85))
    trades = [r["trades"]["daa"] for r in result["daily"][0]["schedule"]]
    for i in range(0, 96, 4):
        assert all(t["buyMW"] == pytest.approx(trades[i]["buyMW"]) and t["sellMW"] == pytest.approx(trades[i]["sellMW"]) for t in trades[i:i+4])


@pytest.mark.parametrize("price", [0, -100, 50])
def test_lossless_flat_prices_no_artificial_revenue(csv_prices, price):
    study = make_study({m: (m, csv_prices(prices=[price])) for m in MARKETS})
    result = engine.optimize(study, Battery(wearCostPerMWh=0, maxCyclesPerDay=1.5, roundtripEfficiency=1))
    assert result["totalRevenue"] == pytest.approx(0)


def test_negative_prices_lossy_no_instantaneous_energy_loop(csv_prices):
    study = make_study({"idc": ("negative.csv", csv_prices(prices=[-100]))})
    result = engine.optimize(study, Battery(wearCostPerMWh=0, capacityMWh=1, maxPowerMW=4, roundtripEfficiency=.81, maxCyclesPerDay=1))
    assert result["totalRevenue"] == pytest.approx(100 * (1/.9 - .9), abs=1e-5)
    assert result["cycles"] == pytest.approx(1.)
    assert all(min(row["chargeMW"], row["dischargeMW"]) == 0 for row in result["daily"][0]["schedule"])


def test_zero_cycle_limit(csv_prices):
    study = make_study({m: (m, csv_prices(prices=[-100, 200])) for m in MARKETS})
    result = engine.optimize(study, Battery(wearCostPerMWh=0, maxCyclesPerDay=0))
    assert result["totalRevenue"] == pytest.approx(0)
    assert result["cycles"] == pytest.approx(0)


def test_closing_financial_positions_does_not_cycle_battery(csv_prices):
    study = make_study({"daa": ("da", csv_prices(minutes=60, prices=[50] * 12 + [100] * 12)),
                        "ida": ("id", csv_prices(prices=[90] * 48 + [10] * 48))})
    result = engine.optimize(study, Battery(wearCostPerMWh=0, capacityMWh=1, maxPowerMW=2, roundtripEfficiency=.81, maxCyclesPerDay=1))
    assert result["marketRevenue"]["daa"] == pytest.approx(90 - 50/.9, abs=1e-5)
    assert result["marketRevenue"]["ida"] == pytest.approx(90/.9 - 10*.9, abs=1e-5)
    assert result["cycles"] == pytest.approx(0, abs=1e-6)
    assert sum(r["trades"]["ida"]["buyToCloseMW"] for r in result["daily"][0]["schedule"]) > 0


def test_earlier_stage_has_no_future_market_prices(csv_prices):
    a = make_study({"daa": ("da", csv_prices(minutes=60)), "idc": ("id", csv_prices(prices=[-5, 400]))})
    b = make_study({"daa": ("da", csv_prices(minutes=60)), "idc": ("id", csv_prices(prices=[80, 20]))})
    ra, rb = engine.optimize(a, Battery(wearCostPerMWh=0, maxCyclesPerDay=1.5)), engine.optimize(b, Battery(wearCostPerMWh=0, maxCyclesPerDay=1.5))
    assert [r["trades"]["daa"] for r in ra["daily"][0]["schedule"]] == [r["trades"]["daa"] for r in rb["daily"][0]["schedule"]]


@pytest.mark.parametrize("condition", [TerminationCondition.maxTimeLimit, TerminationCondition.infeasible, TerminationCondition.unbounded])
def test_failed_solver_never_loads_or_returns_results(condition, monkeypatch):
    # This unit test isolates status handling; construction/physics are tested
    # separately against real upstream models and the real GLPK executable.
    monkeypatch.setattr(engine, "adapt_model", lambda *_: None)
    ctx = engine.StageContext("daa", Battery(wearCostPerMWh=0, maxCyclesPerDay=1.5, roundtripEfficiency=1), MarketDay((0.,)*96, 60), (0.,)*96, (0.,)*96)
    owner = SimpleNamespace(context=ctx, captured=None)
    class FailedSolver:
        def solve(self, model, **kwargs):
            assert kwargs == {"timelimit": 30, "load_solutions": False}
            return SimpleNamespace(solver=SimpleNamespace(status=SolverStatus.ok, termination_condition=condition))
    with pytest.raises(engine.CalculationError, match="did not finish optimally"):
        engine.CheckedSolver(owner, FailedSolver()).solve(pyo.ConcreteModel(), timelimit=5)
    assert owner.captured is None


def test_missing_solver_and_changed_source_fail(monkeypatch):
    monkeypatch.setattr(engine, "solver_path", lambda: None)
    with pytest.raises(engine.CalculationError, match="not found"):
        engine.solver_info()
    monkeypatch.setitem(engine.PROVENANCE, "sha256", "changed")
    with pytest.raises(engine.CalculationError, match="fingerprint"):
        engine.solver_info()
