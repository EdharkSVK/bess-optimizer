import pytest
from pydantic import ValidationError

from backend.domain import Battery, InputError, make_study


def test_common_complete_days(csv_prices):
    study = make_study({"daa": ("da.csv", csv_prices(days=3, minutes=60)),
                        "idc": ("continuous.csv", csv_prices(day="2025-01-02", days=3))})
    assert study.preview["includedDates"] == ["2025-01-02", "2025-01-03"]
    assert [d["date"] for d in study.preview["excludedDates"]] == ["2025-01-01", "2025-01-04"]
    assert study.days["2025-01-02"]["daa"].prices[:4] == (10.,) * 4
    assert study.days["2025-01-02"]["daa"].product_minutes == 60


@pytest.mark.parametrize("day", ["2025-03-30", "2025-10-26"])
@pytest.mark.parametrize("aware", [True, False])
def test_calendar_clock_change_exclusion(csv_prices, day, aware):
    study = make_study({"idc": ("id.csv", csv_prices(day=day, days=2, aware=aware))})
    assert len(study.days) == 1
    assert study.preview["excludedDates"][0]["date"] == day
    assert "Clock-change" in study.preview["excludedDates"][0]["reasons"][0]


def test_missing_interval_is_not_a_clock_change(csv_prices):
    lines = csv_prices().decode().splitlines()
    study = make_study({"ida": ("missing.csv", "\n".join(lines[:30] + lines[31:]).encode())})
    assert not study.preview["canRun"]
    assert "incomplete" in study.preview["excludedDates"][0]["reasons"][0]


def test_gaps_with_whole_missing_days_are_listed(csv_prices):
    a = csv_prices().decode()
    b = csv_prices(day="2025-01-03").decode().split("\n", 1)[1]
    study = make_study({"ida": ("gaps.csv", (a + b).encode())})
    assert list(study.days) == ["2025-01-01", "2025-01-03"]
    assert study.preview["excludedDates"][0]["date"] == "2025-01-02"


def test_mixed_day_ahead_product_history(csv_prices):
    data = csv_prices(minutes=60).decode() + csv_prices(day="2025-01-02").decode().split("\n", 1)[1]
    study = make_study({"daa": ("mixed.csv", data.encode())})
    assert [d["daa"].product_minutes for d in study.days.values()] == [60, 15]
    assert study.preview["files"][0]["intervalsMinutes"] == [15, 60]


def test_repeated_hourly_override(csv_prices):
    data = csv_prices(prices=[20] * 4 + [50] * 4)
    study = make_study({"daa": ("da.csv", data)}, product="60")
    assert study.days["2025-01-01"]["daa"].product_minutes == 60
    invalid = make_study({"daa": ("da.csv", csv_prices(prices=[20, 50]))}, product="60")
    assert not invalid.preview["canRun"]
    assert "four identical" in invalid.preview["issues"][0]["message"]
    assert make_study({"daa": ("da.csv", data)}).days["2025-01-01"]["daa"].product_minutes == 15


def test_hourly_intraday_not_fabricated(csv_prices):
    study = make_study({"ida": ("id.csv", csv_prices(minutes=60))})
    assert not study.preview["canRun"]
    assert "96 quarter-hourly" in study.preview["excludedDates"][0]["reasons"][0]


@pytest.mark.parametrize("value", ["", "NaN", "Infinity", "12eur", "2025-01-01"])
def test_invalid_prices_report_filename_row(value):
    study = make_study({"daa": ("bad.csv", f"datetime,price\n2025-01-01T00:00,{value}\n".encode())})
    issue = study.preview["issues"][0]
    assert (issue["filename"], issue["row"], issue["date"], issue["price"]) == ("bad.csv", 2, "2025-01-01", value)
    assert issue["code"] == "price"
    assert not study.preview["canRun"]


@pytest.mark.parametrize("data", [b"time,price\n2025-01-01,2", b"datetime;price\n2025-01-01;2", b"datetime,price,price\n2025-01-01,2,2", b"\xff\xfe"])
def test_invalid_csv_contract(data):
    study = make_study({"daa": ("bad.csv", data)})
    assert not study.preview["canRun"]
    assert study.preview["blockingFiles"] == ["daa"]
    assert study.preview["issues"][0]["scope"] == "file"


def test_duplicates_include_both_rows(csv_prices):
    data = csv_prices()
    study = make_study({"ida": ("duplicate.csv", data + data.splitlines()[1] + b"\n")})
    issue = study.preview["issues"][0]
    assert issue["code"] == "duplicate"
    assert issue["relatedRow"] == 2
    assert issue["row"] == 98
    assert not study.preview["canRun"]


def test_bom_negative_zero_extra_columns_and_reversed_order(csv_prices):
    lines = csv_prices(prices=[0, -50]).decode().splitlines()
    data = ('\ufeff PRICE ,DATETIME,other\n' + '\n'.join(f'{p},{stamp},x' for stamp, p in (line.split(',') for line in lines[:0:-1]))).encode()
    study = make_study({"ida": ("valid.csv", data)})
    assert study.days["2025-01-01"]["ida"].prices[:2] == (0, -50)


def test_equivalent_offset_timestamps(csv_prices):
    original = csv_prices().decode()
    from datetime import datetime, timezone
    converted = "datetime,price\n" + "\n".join(
        datetime.fromisoformat(stamp).astimezone(timezone.utc).isoformat() + "," + price
        for stamp, price in (line.split(",") for line in original.splitlines()[1:]))
    a = make_study({"ida": ("a.csv", original.encode())})
    b = make_study({"ida": ("b.csv", converted.encode())})
    assert a.days == b.days


def test_invalid_timezone_and_empty_upload():
    with pytest.raises(InputError):
        make_study({})
    with pytest.raises(InputError, match="timezone"):
        make_study({"ida": ("x", b"datetime,price")}, tz_name="not/a-zone")


@pytest.mark.parametrize("values", [{"capacityMWh": 0}, {"maxPowerMW": -1}, {"roundtripEfficiency": 0},
    {"roundtripEfficiency": 1.01}, {"maxCyclesPerDay": -1}, {"capacityMWh": float("inf")}])
def test_battery_boundaries(values):
    with pytest.raises(ValidationError):
        Battery(**values)


def test_full_year_calendar(csv_prices):
    study = make_study({"ida": ("year.csv", csv_prices(days=365))})
    assert len(study.days) == 363
    assert [d["date"] for d in study.preview["excludedDates"]] == ["2025-03-30", "2025-10-26"]
