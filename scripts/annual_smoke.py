"""Exercise the real HTTP API and all three market stages over a calendar year.

Start Docker first, then run: python scripts/annual_smoke.py
For a direct backend, pass --url http://127.0.0.1:8000.
Writes only the compact validation report, not uploaded price data, to .tools/.
"""
import argparse
import csv
import io
import json
import math
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx


def annual_csv(market):
    stream = io.StringIO(newline="")
    writer = csv.writer(stream)
    writer.writerow(["datetime", "price"])
    zone = ZoneInfo("Europe/Prague")
    start = datetime(2025, 1, 1, tzinfo=zone).astimezone(timezone.utc)
    end = datetime(2026, 1, 1, tzinfo=zone).astimezone(timezone.utc)
    minutes = 60 if market == "daa" else 15
    now = start
    while now < end:
        local = now.astimezone(zone)
        hour = local.hour + local.minute / 60
        base = 55 + 35 * math.sin((hour - 10) * math.pi / 12)
        extra = 0 if market == "daa" else (5 if market == "ida" else 9) * math.sin(hour * 2.1 + local.timetuple().tm_yday * .3)
        writer.writerow([local.isoformat(), round(base + extra, 4)])
        now += timedelta(minutes=minutes)
    return stream.getvalue().encode()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://localhost:8082")
    args = parser.parse_args()
    started = time.monotonic()
    with httpx.Client(base_url=args.url, timeout=120) as client:
        health = client.get("/api/health")
        health.raise_for_status()
        response = client.post("/api/studies", files={m: (m + ".csv", annual_csv(m), "text/csv") for m in ("daa", "ida", "idc")})
        response.raise_for_status()
        study = response.json()
        assert study["preview"]["modelledDays"] == 363
        assert [d["date"] for d in study["preview"]["excludedDates"]] == ["2025-03-30", "2025-10-26"]
        response = client.post("/api/runs", json={"studyId": study["studyId"], "battery": {}})
        response.raise_for_status()
        run_id = response.json()["runId"]
        reported = -1
        while True:
            response = client.get(f"/api/runs/{run_id}")
            response.raise_for_status()
            run = response.json()
            count = run["completedDays"]
            if count // 30 != reported:
                print(f"Progress: {count}/363 days, {time.monotonic()-started:.1f}s", flush=True)
                reported = count // 30
            assert run["status"] != "failed", run.get("error")
            if run["status"] == "completed":
                break
            time.sleep(.3)
        result = run["result"]
    rows = [r for day in result["daily"] for r in day["schedule"]]
    assert len(rows) == 363 * 96
    assert all(len(s["socBoundariesMWh"]) == 97 and s["solverStatus"] == "optimal" for day in result["daily"] for s in day["stages"].values())
    assert math.isclose(sum(r["revenue"] for r in rows), result["totalRevenue"], abs_tol=1e-4)
    assert math.isclose(sum(result["marketRevenue"].values()), result["totalRevenue"], abs_tol=1e-4)
    assert math.isclose(sum(r["wearCost"] for r in rows), result["wearCost"], abs_tol=1e-4)
    assert math.isclose(sum(r["wearAdjustedMargin"] for r in rows), result["wearAdjustedMargin"], abs_tol=1e-4)
    assert math.isclose(result["wearAdjustedMargin"], result["totalRevenue"]-result["wearCost"], abs_tol=1e-4)
    assert math.isclose(result["averageCyclesPerDay"], result["cycles"]/363, abs_tol=1e-6)
    battery = result["metadata"]["battery"]
    capacity, power = battery["capacityMWh"], battery["maxPowerMW"]
    eta = math.sqrt(battery["roundtripEfficiency"])
    tolerance = 1e-6
    assert result["metadata"]["adaptations"]["physicalExclusivity"]
    assert result["metadata"]["adaptations"]["sameStageTradeExclusivity"]
    for day in result["daily"]:
        stage_charge = {m: 0. for m in day["stages"]}
        stage_discharge = dict(stage_charge)
        for i, row in enumerate(day["schedule"]):
            charge = discharge = 0.
            for market in result["metadata"]["stageOrder"]:
                trade = row["trades"][market]
                buy = trade["buyMW"] + trade["buyToCloseMW"]
                sell = trade["sellMW"] + trade["sellToCloseMW"]
                assert min(buy, sell) <= tolerance
                assert trade["sellToCloseMW"] <= charge + tolerance
                assert trade["buyToCloseMW"] <= discharge + tolerance
                charge += trade["buyMW"] - trade["sellToCloseMW"]
                discharge += trade["sellMW"] - trade["buyToCloseMW"]
                assert -tolerance <= min(charge, discharge) <= tolerance
                assert max(charge, discharge) <= power + tolerance
                soc = day["stages"][market]["socBoundariesMWh"]
                assert -tolerance <= soc[i+1] <= capacity + tolerance
                assert math.isclose(soc[i+1], soc[i] + .25*(eta*charge-discharge/eta), abs_tol=tolerance)
                assert math.isclose(trade["revenue"], .25*trade["price"]*(sell-buy), abs_tol=tolerance)
                stage_charge[market] += .25 * eta * charge
                stage_discharge[market] += .25 * discharge / eta
            assert math.isclose(charge, row["chargeMW"], abs_tol=tolerance)
            assert math.isclose(discharge, row["dischargeMW"], abs_tol=tolerance)
            internal_discharge = .25*discharge/eta
            assert math.isclose(row["internalDischargedMWh"], internal_discharge, abs_tol=tolerance)
            assert math.isclose(row["cycles"], internal_discharge/capacity, abs_tol=tolerance)
            assert math.isclose(row["wearCost"], internal_discharge*battery["wearCostPerMWh"], abs_tol=tolerance)
            assert math.isclose(row["wearAdjustedMargin"], row["revenue"]-row["wearCost"], abs_tol=tolerance)
        for market, stage in day["stages"].items():
            assert abs(stage["socBoundariesMWh"][0]) <= tolerance
            assert abs(stage["socBoundariesMWh"][-1]) <= tolerance
            if battery["maxCyclesPerDay"] is not None:
                assert max(stage_charge[market], stage_discharge[market]) <= capacity*battery["maxCyclesPerDay"] + tolerance
            assert stage["wearAdjustedGain"] >= -tolerance
        assert math.isclose(day["cycles"], stage_discharge[result["metadata"]["stageOrder"][-1]]/capacity, abs_tol=tolerance)
        assert math.isclose(sum(s["wearCostChange"] for s in day["stages"].values()), day["wearCost"], abs_tol=tolerance)
        assert math.isclose(day["wearCost"], day["cycles"]*capacity*battery["wearCostPerMWh"], abs_tol=tolerance)
    report = {"modelledDays": 363, "excludedDays": 2, "quarterHourRows": len(rows),
        "marketRevenue": result["marketRevenue"], "totalRevenue": result["totalRevenue"],
        "cycles": result["cycles"], "elapsedSeconds": time.monotonic()-started,
        "wearCost": result["wearCost"], "wearAdjustedMargin": result["wearAdjustedMargin"],
        "averageCyclesPerDay": result["averageCyclesPerDay"],
        "serializedResultBytes": len(response.content), "solver": result["metadata"]["solver"],
        "wrapperVersion": result["metadata"]["wrapperVersion"], "url": args.url,
        "physicalAndTradingReconciliation": "passed for every interval and stage"}
    output = Path(".tools/annual-smoke.json")
    output.parent.mkdir(exist_ok=True)
    output.write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
