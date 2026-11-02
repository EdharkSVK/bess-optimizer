"""Economic dispatch and accounting, independent of legacy lossless references."""
import math
import itertools

import pytest
from pydantic import ValidationError

from backend.domain import Battery, make_study
from backend.engine import optimize


def test_defaults_replace_daily_cap_with_wear():
    battery = Battery()
    assert battery.wearCostPerMWh == 20
    assert battery.maxCyclesPerDay is None


@pytest.mark.parametrize("value", [-1, float("inf"), float("nan")])
def test_invalid_wear_rejected(value):
    with pytest.raises(ValidationError):
        Battery(wearCostPerMWh=value)


@pytest.mark.parametrize("market,minutes", [("daa", 60), ("ida", 15), ("idc", 15)])
@pytest.mark.parametrize("efficiency", [1., .81])
def test_unprofitable_spread_is_rejected_before_dispatch(csv_prices, market, minutes, efficiency):
    study = make_study({market: ("prices.csv", csv_prices(minutes=minutes, prices=[10]*12 + [25]*12))})
    b = dict(capacityMWh=1, maxPowerMW=1, roundtripEfficiency=efficiency)
    free = optimize(study, Battery(**b, wearCostPerMWh=0))
    costly = optimize(study, Battery(**b, wearCostPerMWh=30))
    assert free["cycles"] > 0
    assert costly["cycles"] == pytest.approx(0, abs=1e-7)
    assert costly["wearCost"] == pytest.approx(0, abs=1e-7)
    assert costly["wearAdjustedMargin"] == pytest.approx(0, abs=1e-7)


@pytest.mark.parametrize("efficiency", [1., .81])
def test_internal_wear_units_and_economic_objective(csv_prices, efficiency):
    study = make_study({"daa": ("prices.csv", csv_prices(minutes=60, prices=[10]*12 + [100]*12))})
    result = optimize(study, Battery(capacityMWh=1, maxPowerMW=1,
        roundtripEfficiency=efficiency, wearCostPerMWh=20))
    eta = math.sqrt(efficiency)
    assert result["cycles"] == pytest.approx(1)
    assert result["internalDischargedMWh"] == pytest.approx(1)
    assert result["totalRevenue"] == pytest.approx(100*eta - 10/eta)
    assert result["wearCost"] == pytest.approx(20)
    assert result["wearAdjustedMargin"] == pytest.approx(100*eta - 10/eta - 20)
    rows = result["daily"][0]["schedule"]
    assert sum(r["cycles"] for r in rows) == pytest.approx(1)
    assert sum(r["wearAdjustedMargin"] for r in rows) == pytest.approx(result["wearAdjustedMargin"])


def test_physics_remains_bounded_without_arbitrary_cycle_cap(csv_prices):
    study = make_study({"idc": ("many-cycles.csv", csv_prices(prices=[0]*4 + [100]*4))})
    args = dict(capacityMWh=1, maxPowerMW=1, roundtripEfficiency=1, wearCostPerMWh=20)
    free = optimize(study, Battery(**args))
    capped = optimize(study, Battery(**args, maxCyclesPerDay=1.5))
    stopped = optimize(study, Battery(**args, maxCyclesPerDay=0))
    assert free["cycles"] == pytest.approx(12)
    assert capped["cycles"] == pytest.approx(1.5)
    assert stopped["cycles"] == pytest.approx(0)
    assert free["wearAdjustedMargin"] == pytest.approx(12*80)
    for row in free["daily"][0]["schedule"]:
        assert 0 <= row["chargeMW"] <= 1 + 1e-7
        assert 0 <= row["dischargeMW"] <= 1 + 1e-7
        assert min(row["chargeMW"], row["dischargeMW"]) <= 1e-7
        assert -1e-7 <= row["socEndMWh"] <= 1 + 1e-7


def test_financial_closures_do_not_double_charge_physical_wear(csv_prices):
    files = {
        "daa": ("da.csv", csv_prices(minutes=60, prices=[10]*12 + [100]*12)),
        "ida": ("ida.csv", csv_prices(prices=[90]*48 + [10]*48)),
        "idc": ("idc.csv", csv_prices(prices=[0]*48 + [100]*48)),
    }
    result = optimize(make_study(files), Battery(capacityMWh=1, maxPowerMW=1,
        roundtripEfficiency=1, wearCostPerMWh=20))
    day = result["daily"][0]
    assert result["totalRevenue"] == pytest.approx(270)
    assert result["cycles"] == pytest.approx(1)
    assert result["wearCost"] == pytest.approx(20)
    assert result["wearAdjustedMargin"] == pytest.approx(250)
    assert sum(s["wearCostChange"] for s in day["stages"].values()) == pytest.approx(20)
    assert sum(s["wearAdjustedGain"] for s in day["stages"].values()) == pytest.approx(250)
    assert day["stages"]["ida"]["wearCostChange"] == pytest.approx(-20)


def test_closing_at_cash_loss_can_be_rational_when_it_saves_more_wear(csv_prices):
    files = {
        "daa": ("da.csv", csv_prices(minutes=60, prices=[10]*12 + [100]*12)),
        "ida": ("ida.csv", csv_prices(prices=[9]*48 + [101]*48)),
        "idc": ("idc.csv", csv_prices(prices=[49]*48 + [51]*48)),
    }
    result = optimize(make_study(files), Battery(capacityMWh=1, maxPowerMW=1,
        roundtripEfficiency=1, wearCostPerMWh=20))
    assert result["marketRevenue"]["idc"] == pytest.approx(-2)
    assert result["wearCost"] == pytest.approx(0, abs=1e-6)
    assert result["cycles"] == pytest.approx(0, abs=1e-6)
    assert result["daily"][0]["stages"]["idc"]["wearAdjustedGain"] == pytest.approx(18)


def test_average_includes_zero_cycle_days_and_excludes_missing_days(csv_prices):
    first = csv_prices(day="2025-01-01", prices=[0]*48 + [100]*48)
    third = csv_prices(day="2025-01-03", prices=[50]*96).split(b"\n", 1)[1]
    result = optimize(make_study({"idc": ("gaps.csv", first + third)}), Battery(
        capacityMWh=1, maxPowerMW=1, roundtripEfficiency=1, wearCostPerMWh=20))
    assert result["coverage"]["excludedDays"] == 1
    assert result["cycles"] == pytest.approx(1)
    assert result["averageCyclesPerDay"] == pytest.approx(.5)


@pytest.mark.parametrize("markets", [c for n in (1, 2, 3) for c in itertools.combinations(("daa", "ida", "idc"), n)])
@pytest.mark.parametrize("efficiency", [1., .85])
def test_wear_reconciles_for_every_market_combination(csv_prices, markets, efficiency):
    files = {m: (m, csv_prices(minutes=60 if m == "daa" else 15,
        prices=([10]*12 + [100]*12) if m == "daa" else [5]*48 + [110]*48)) for m in markets}
    b = Battery(capacityMWh=1, maxPowerMW=1, roundtripEfficiency=efficiency, wearCostPerMWh=20)
    result = optimize(make_study(files), b)
    day = result["daily"][0]
    assert set(day["stages"]) == set(markets)
    assert result["wearAdjustedMargin"] >= -1e-6
    assert result["wearCost"] == pytest.approx(result["cycles"]*20)
    assert result["wearAdjustedMargin"] == pytest.approx(result["totalRevenue"]-result["wearCost"])
    assert sum(s["wearCostChange"] for s in day["stages"].values()) == pytest.approx(result["wearCost"])
    assert all(s["wearAdjustedGain"] >= -1e-6 for s in day["stages"].values())
