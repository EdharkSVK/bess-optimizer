from datetime import timedelta
import gzip
import time
from zoneinfo import ZoneInfo

from fastapi.testclient import TestClient
import numpy as np
import pytest

from backend import btm
from backend.app import create_app
from backend.btm import BtmRequest, Costs, Size, candidate_sizes, dispatch, evaluate, fixed_cost
from backend.domain import Battery, MARKETS, MarketDay, Study
from backend.engine import optimize, solver_info
from backend.hybrid import HybridRequest, hybrid_day, new_solver, prepare_hybrid, pv_quarters, utc_hours
from backend.profiles import HOUR, ProfileCatalog, TECHNOLOGIES, replay_load, validate_pv_rows, year_hours, year_start


@pytest.fixture
def catalog(tmp_path):
    for tech in TECHNOLOGIES:
        for year in (2020, 2021):
            with gzip.open(tmp_path / f"pv-{tech}-{year}.csv.gz", "wt") as file:
                file.write("datetime,capacity_factor\n")
                for hour in range(year_hours(year)):
                    stamp = year_start(year) + hour * HOUR
                    file.write(f"{stamp.isoformat()},{0.5 if stamp.hour == 11 else 0}\n")
    np.savez_compressed(tmp_path / "load-de-2017.npz", sites=[f"LG {i:02d}" for i in range(1, 31)],
                        hourly=np.full((30, 8760), 0.1))
    return ProfileCatalog(tmp_path)


def test_catalog_api_preserves_leap_hours_and_csv(catalog):
    with TestClient(create_app(profile_path=catalog.path)) as client:
        metadata = client.get("/api/profiles").json()
        assert metadata["years"] == [2020, 2021]
        assert len(metadata["loadSites"]) == 30
        response = client.get("/api/profiles/pv/fixed/2020").json()
        assert len(response["capacityFactors"]) == 8784
        assert response["fullLoadHours"] == 183
        csv = client.get("/api/profiles/pv/fixed/2020/csv")
        assert "attachment" in csv.headers["content-disposition"]
        assert len(csv.text.splitlines()) == 8785
        assert client.get("/api/profiles/pv/fixed/2019").status_code == 404


def test_pv_gap_rejected():
    with pytest.raises(ValueError, match="Missing, duplicate or off-grid"):
        validate_pv_rows([(year_start(2020) + HOUR, "0")], 2020)


def test_load_calendar_repeats_february_without_smoothing():
    base = np.ones(8760)
    leap_start = (31 + 28) * 24
    base[leap_start - 1] = 10
    replay = replay_load(base, 2020, 1000)
    assert len(replay) == 8784
    assert replay.sum() == pytest.approx(1000)
    assert replay[leap_start + 23] == replay[leap_start - 1]
    assert replay[leap_start + 23] / replay[0] == 10


def test_btm_overnight_and_charge_opportunity_cost():
    # PV starts at 22 UTC / 23 Czech local and demand starts after midnight.
    load, pv = np.zeros(48), np.zeros(48)
    pv[22], load[24] = 2, 2
    battery = Battery(capacityMWh=2, maxPowerMW=2, roundtripEfficiency=1, wearCostPerMWh=10)
    _, charge, discharge, export, soc = dispatch(2021, load, pv, battery, 100, 30)
    assert charge[22] == 2 and discharge[24] == 2
    assert soc[23] == soc[24] == 2 and soc[-1] == 0
    assert export.sum() == 0
    _, charge, discharge, export, _ = dispatch(2021, load, pv, battery, 100, 95)
    assert charge.sum() == discharge.sum() == 0 and export[22] == 2
    _, charge, discharge, export, _ = dispatch(2021, load, pv, battery, 100, 95, export_limit=1)
    assert charge[22] == discharge[24] == export[22] == 1


def test_btm_daily_limit_and_loss():
    load, pv = np.zeros(48), np.zeros(48)
    pv[22], load[24] = 2, 2
    battery = Battery(capacityMWh=2, maxPowerMW=2, roundtripEfficiency=.81, wearCostPerMWh=0, maxCyclesPerDay=.5)
    _, charge, discharge, _, soc = dispatch(2021, load, pv, battery, 100, 0)
    assert charge[22] == pytest.approx(1 / .9)
    assert discharge[24] == pytest.approx(.9)
    assert soc[0] == soc[-1] == 0


def test_pv_only_billing_and_sizing_cost():
    req = BtmRequest(technology="industrial", annualLoadMWh=4, importTariff=100, exportTariff=30,
                     sizes=[Size(pvMWp=2, batteryMW=1, batteryMWh=4)])
    load, pv_cf = np.array([2., 2., 0]), np.array([.5, 0, 1])
    variants = candidate_sizes(req)
    result = evaluate(req, variants[1][1], 2021, load, pv_cf)
    assert (result["baselineBill"], result["importCost"], result["exportReceipts"], result["netSavings"]) == (400, 300, 60, 160)
    costs = Costs(pvCapexPerMWp=100, batteryCapexPerMW=40, batteryCapexPerMWh=10, pvOpexPerMWpYear=1,
                  batteryOpexPerMWhYear=2, pvLifeYears=10, batteryLifeYears=5, discountRate=0)
    assert fixed_cost(req.sizes[0], costs) == (36, 10)


def wait_job(client, response):
    assert response.status_code == 202, response.text
    run_id = response.json()["runId"]
    for _ in range(400):
        run = client.get(f"/api/runs/{run_id}").json()
        if run["status"] == "completed":
            return run_id, run["result"]
        assert run["status"] != "failed", run
        time.sleep(.025)
    pytest.fail("Background solar job expired in test")


def test_btm_run_and_dispatch_api(catalog):
    with TestClient(create_app(profile_path=catalog.path)) as client:
        run_id, result = wait_job(client, client.post("/api/btm/runs", json={
            "technology": "industrial", "annualLoadMWh": 876, "importTariff": 100, "exportTariff": 45,
            "years": [2020, 2021], "sites": ["LG 01"],
            "sizes": [{"pvMWp": 1, "batteryMW": 0.2, "batteryMWh": 1}],
            "battery": {"roundtripEfficiency": .85, "wearCostPerMWh": 20},
            "costs": {"pvCapexPerMWp": 100, "batteryCapexPerMW": 10, "batteryCapexPerMWh": 20,
                      "pvOpexPerMWpYear": 5, "batteryOpexPerMWhYear": 5,
                      "pvLifeYears": 10, "batteryLifeYears": 5, "discountRate": 0},
        }))
        assert result["scenarioCount"] == 2
        assert result["candidates"][0]["summary"]["netSavings"]["mean"] == 0
        assert result["candidates"][1]["summary"]["netSavings"]["mean"] > 0
        _, detail = wait_job(client, client.post(f"/api/btm/runs/{run_id}/detail",
                                                  json={"year": 2021, "site": "LG 01", "candidate": 1}))
        assert len(detail["rows"]) == 8760
        assert detail["rows"][11]["pvMW"] == .5
        profiles = []
        for year in (2020, 2021):
            _, detail = wait_job(client, client.post(f"/api/btm/runs/{run_id}/detail",
                                                      json={"year": year, "site": "LG 01", "candidate": 2}))
            profiles.append(detail["rows"])
        average = result["candidates"][2]["averageDay"]
        assert len(average) == 24
        assert average[11]["pvChargeMW"] > 0
        assert average[11]["exportMW"] > 0
        assert sum(hour["batteryToLoadMW"] for hour in average) > 0
        for hour, values in enumerate(average):
            for key, value in values.items():
                expected = np.mean([np.mean([row[key] for row in rows[hour::24]]) for rows in profiles])
                assert value == pytest.approx(expected)

        candidate = result["candidates"][2]
        earnings = candidate["earnings"]
        assert [row["date"] for row in earnings["daily"][58:61]] == ["02-28", "02-29", "03-01"]
        assert len(earnings["daily"]) == 366
        february_earnings = []
        for scenario, rows in zip(candidate["scenarios"], profiles, strict=True):
            days = 60 if scenario["year"] == 2020 else 59
            hourly_savings = [(row["loadMW"] - row["importMW"]) * 100 + row["exportMW"] * 45
                              - row["batteryToLoadMW"] * 20 / np.sqrt(.85) for row in rows[:days * 24]]
            prorated_cost = (scenario["annualizedCapex"] + scenario["fixedOpex"]) * days / (len(rows) / 24)
            february_earnings.append(sum(hourly_savings) - prorated_cost)
        leap_day = earnings["daily"][59]
        assert leap_day["min"] == pytest.approx(min(february_earnings))
        assert leap_day["median"] == pytest.approx(np.median(february_earnings))
        assert leap_day["max"] == pytest.approx(max(february_earnings))
        assert earnings["daily"][-1] == dict(date="12-31", **{
            key: candidate["summary"]["netSavings"][key] for key in ("min", "median", "max")
        })
        assert earnings["yearly"] == [
            dict(year=row["year"], min=row["netSavings"], median=row["netSavings"], max=row["netSavings"])
            for row in candidate["scenarios"]
        ]


def test_btm_ranking_uses_median_even_when_the_mean_favors_an_outlier(catalog, monkeypatch):
    values_by_size = {1: iter([10., 10., 100.]), 2: iter([20., 20., 20.])}

    def sample(_request, size, _year, _load, _factor, *, average_day, earnings_curves):
        earnings = next(values_by_size[size.pvMWp]) if size else 0.
        earnings_curves.append(np.linspace(earnings / 365, earnings, 365))
        return {"annualizedCapex": 0., "netSavings": earnings}

    monkeypatch.setattr(btm, "evaluate", sample)
    costs = Costs(pvCapexPerMWp=0, batteryCapexPerMW=0, batteryCapexPerMWh=0, pvOpexPerMWpYear=0,
                  batteryOpexPerMWhYear=0, pvLifeYears=1, batteryLifeYears=1, discountRate=0)
    request = BtmRequest(technology="industrial", annualLoadMWh=1000, importTariff=100, exportTariff=45,
                         sizes=[Size(pvMWp=1), Size(pvMWp=2)], mode="sizing", costs=costs)
    result = btm.run_btm(request, catalog, [2021], ["LG 01", "LG 02", "LG 03"], lambda _: None)
    assert result["ranking"] == [2, 1, 0]
    assert result["candidates"][1]["earnings"]["yearly"] == [dict(year=2021, min=10., median=10., max=100.)]
    assert len(result["candidates"][1]["earnings"]["daily"]) == 365


def request(**overrides):
    values = dict(studyId="test", technology="fixed", pvMWp=2, importLimitMW=1, exportLimitMW=1,
                  battery=Battery(capacityMWh=2, maxPowerMW=1, roundtripEfficiency=1, wearCostPerMWh=1))
    return HybridRequest(**(values | overrides))


def test_utility_calendar_and_quarter_energy(catalog):
    keys = ["2020-02-27", "2020-02-28", "2020-02-29", "2020-03-01", "2020-03-02"]
    market_study = Study("test", "Europe/Prague", {key: {} for key in keys}, {"markets": list(MARKETS)})
    replay = request(studyMode="weather", priceYear=2020)
    scenarios, coverage = prepare_hybrid(replay, market_study, catalog)
    assert scenarios[2020] == scenarios[2021] == ("2020-02-27", "2020-02-28", "2020-03-02")
    assert coverage[0]["excludedPvDays"] == 2
    quarters = pv_quarters(catalog, replay, 2021, "2020-02-27", ZoneInfo("Europe/Prague"))
    assert quarters.sum() / 4 == 1
    assert quarters[12 * 4:13 * 4].tolist() == [1] * 4
    assert utc_hours("2020-07-01", ZoneInfo("Europe/Prague"))[0].hour == 22


def markets():
    prices = np.repeat(np.r_[np.full(6, 30.), np.full(6, 40.), np.full(6, 10.), np.full(6, 100.)], 4)
    return {key: MarketDay(tuple(prices), 60 if key == "daa" else 15) for key in MARKETS}


def test_utility_green_closes_trades_without_physical_grid_charge():
    solver_info()
    data = markets()
    pv = np.zeros(96)
    pv[48:60] = 1
    solver = new_solver()
    original = hybrid_day(request(), data, pv, solver, "2021-01-03", detail=True)
    closing_prices = list(data["ida"].prices)
    closing_prices[72:80] = [-100] * 8
    data["ida"] = MarketDay(tuple(closing_prices), 15)
    solved = hybrid_day(request(), data, pv, solver, "2021-01-03", detail=True)
    rows, metrics = solved["rows"], solved["metrics"]
    assert metrics["pvChargeMWh"] > 0
    assert metrics["gridChargeMWh"] == 0
    assert metrics["marketRevenue"]["daa"] == original["metrics"]["marketRevenue"]["daa"]
    assert sum(row["ida_buyToClose"] for row in rows) > 0
    for row in rows:
        delta = sum(row[f"{m}_sell"] + row[f"{m}_sellToClose"] - row[f"{m}_buy"] - row[f"{m}_buyToClose"] for m in MARKETS)
        assert delta == pytest.approx(row["exportMW"] - row["gridChargeMW"], abs=1e-6)
        assert row["pvMW"] == pytest.approx(row["pvChargeMW"] + row["pvExportMW"] + row["curtailMW"], abs=1e-6)


def test_zero_pv_hybrid_matches_standalone_economics():
    battery = Battery(capacityMWh=2, maxPowerMW=1, roundtripEfficiency=.81, wearCostPerMWh=11)
    data = markets()
    key = "2021-01-03"
    legacy = optimize(Study("test", "Europe/Prague", {key: data}, {"markets": list(MARKETS)}), battery)
    hybrid = hybrid_day(request(pvMWp=0, battery=battery, charging="pv_grid"), data, np.zeros(96), new_solver(), key)
    assert hybrid["gridChargeMWh"] > 0
    assert hybrid["marketRevenue"] == pytest.approx(legacy["marketRevenue"], abs=1e-5)
    assert hybrid["margin"] == pytest.approx(legacy["wearAdjustedMargin"], abs=1e-5)


def test_utility_job_and_dispatch_api(catalog):
    day = "2021-01-03"
    start = utc_hours(day, ZoneInfo("Europe/Prague"))[0]
    files = {}
    for market, data in markets().items():
        step = 4 if data.product_minutes == 60 else 1
        rows = [f"{(start + timedelta(minutes=15*i)).isoformat()},{data.prices[i]}"
                for i in range(0, 96, step)]
        files[market] = (f"{market}.csv", "datetime,price\n" + "\n".join(rows), "text/csv")
    with TestClient(create_app(profile_path=catalog.path)) as client:
        study = client.post("/api/studies", files=files).json()
        inputs = request(studyId=study["studyId"], studyMode="weather", priceYear=2021).model_dump()
        run_id, result = wait_job(client, client.post("/api/hybrid/runs", json=inputs))
        assert result["priceYear"] == 2021
        assert [record["dates"] for record in result["years"]] == [[day], [day]]
        assert all(record["gridChargeMWh"] == 0 and record["pvMWh"] == 1 for record in result["years"])
        _, detail = wait_job(client, client.post(f"/api/hybrid/runs/{run_id}/detail",
                                                  json={"year": 2020, "date": day}))
        assert len(detail["rows"]) == 96
        assert detail["rows"][0]["datetime"] == "2021-01-02T23:00:00+00:00"
