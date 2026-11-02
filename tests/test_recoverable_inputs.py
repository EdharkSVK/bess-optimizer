"""Dirty price data must never enter a run or discard unrelated complete days."""
import pytest

from backend.domain import make_study


@pytest.mark.parametrize("replacement", [None, "", " ", "NaN", "Infinity", "abc"])
def test_omissions_and_bad_prices_keep_same_good_days(csv_prices, replacement):
    rows = csv_prices(days=3).decode().splitlines()
    original_stamp = rows[10].split(",")[0]
    if replacement is None:
        del rows[10]
    else:
        rows[10] = original_stamp + "," + replacement
    study = make_study({"ida": ("dirty.csv", "\n".join(rows).encode()),
                        "idc": ("complete.csv", csv_prices(days=3))})
    baseline = make_study({"ida": ("clean.csv", csv_prices(day="2025-01-02", days=2)),
                           "idc": ("clean.csv", csv_prices(day="2025-01-02", days=2))})
    assert study.days == baseline.days
    assert study.preview["canRun"]
    assert study.preview["modelledDays"] == 2
    assert [d["date"] for d in study.preview["excludedDates"]] == ["2025-01-01"]
    issue = study.preview["issues"][0]
    assert issue["filename"] == "dirty.csv"
    if replacement is None:
        assert issue["missingTimestamps"] == [original_stamp]
        assert issue["row"] is None
    else:
        assert issue["row"] == 11
        assert issue["datetime"] == original_stamp


def test_collects_all_row_errors_across_all_files(csv_prices):
    ida = csv_prices(days=2).decode().splitlines()
    ida[2] = ida[2].split(",")[0] + ","
    ida[3] = ida[3].split(",")[0] + ",NaN"
    idc = csv_prices(days=2).decode().splitlines()
    idc[4] = idc[4].split(",")[0] + ",not-a-price"
    study = make_study({"ida": ("auction.csv", "\n".join(ida).encode()),
                        "idc": ("continuous.csv", "\n".join(idc).encode())})
    assert [(i["filename"], i["row"], i["code"]) for i in study.preview["issues"]] == [
        ("auction.csv", 3, "price"), ("auction.csv", 4, "price"), ("continuous.csv", 5, "price")]
    assert study.preview["includedDates"] == ["2025-01-02"]
    assert study.preview["issueCount"] == 3


@pytest.mark.parametrize("bad_row", ["nonsense,20", ",20", "nonsense,"])
def test_unknown_date_is_reported_and_complete_grids_still_required(csv_prices, bad_row):
    rows = csv_prices(days=2).decode().splitlines()
    rows[12] = bad_row
    study = make_study({"ida": ("bad-time.csv", "\n".join(rows).encode())})
    assert study.preview["includedDates"] == ["2025-01-02"]
    issue = study.preview["issues"][0]
    assert issue["scope"] == "row" and issue["date"] is None and issue["row"] == 13
    assert any(i["code"] == "missing_intervals" for i in study.preview["issues"])


def test_extra_row_with_unknown_date_does_not_poison_complete_days(csv_prices):
    study = make_study({"ida": ("extra.csv", csv_prices() + b"unknown,123\n")})
    assert study.preview["modelledDays"] == 1
    assert study.preview["issueCount"] == 1
    assert study.preview["issues"][0]["scope"] == "row"


@pytest.mark.parametrize("kind", ["duplicate", "off_grid", "extra_columns"])
def test_bad_rows_exclude_only_their_day(csv_prices, kind):
    rows = csv_prices(days=2).decode().splitlines()
    if kind == "duplicate":
        rows.append(rows[1])
    elif kind == "off_grid":
        rows[1] = rows[1].replace("00:00:00", "00:01:00")
    else:
        rows[1] += ",unexpected"
    study = make_study({"ida": ("bad.csv", "\n".join(rows).encode())})
    assert study.preview["includedDates"] == ["2025-01-02"]
    assert not study.preview["blockingFiles"]


def test_product_override_error_is_local_to_day(csv_prices):
    first = csv_prices(prices=[20, 50])
    second = csv_prices(day="2025-01-02", prices=[10]*4 + [100]*4).split(b"\n", 1)[1]
    study = make_study({"daa": ("mixed.csv", first + second)}, product="60")
    assert study.preview["includedDates"] == ["2025-01-02"]
    assert "four identical" in study.preview["issues"][0]["message"]


def test_missing_hourly_interval_reports_the_correct_grid(csv_prices):
    rows = csv_prices(minutes=60, days=2).decode().splitlines()
    missing = rows.pop(5).split(",")[0]
    study = make_study({"daa": ("hourly.csv", "\n".join(rows).encode())})
    issue = next(i for i in study.preview["issues"] if i["code"] == "missing_intervals")
    assert issue["missingTimestamps"] == [missing]
    assert study.preview["modelledDays"] == 1


def test_all_blank_prices_still_retain_the_date_and_diagnostics(csv_prices):
    rows = csv_prices().decode().splitlines()
    rows[1:] = [row.split(",")[0] + "," for row in rows[1:]]
    study = make_study({"ida": ("empty-prices.csv", "\n".join(rows).encode())})
    assert not study.preview["canRun"]
    assert not study.preview["blockingFiles"]
    assert study.preview["issueCount"] == 96
    assert study.preview["excludedDays"] == 1
    assert study.preview["files"][0]["firstDate"] == "2025-01-01"


@pytest.mark.parametrize("bad_file", [b"wrong,headers\n1,2", b"\xff\xfe", b"datetime,price\n", b'datetime,price\n"unterminated,10\n'])
def test_unreadable_file_never_silently_drops_a_selected_market(csv_prices, bad_file):
    other = csv_prices().decode().splitlines()
    other[2] = other[2].split(",")[0] + ",bad"
    study = make_study({"ida": ("unreadable.csv", bad_file),
                        "idc": ("other.csv", "\n".join(other).encode())})
    assert not study.preview["canRun"]
    assert study.preview["blockingFiles"] == ["ida"]
    assert {i["market"] for i in study.preview["issues"]} == {"ida", "idc"}
    assert study.preview["files"][0]["status"] == "unreadable"


def test_multiline_csv_reports_physical_start_and_end_lines(csv_prices):
    data = csv_prices().decode().replace("datetime,price", "datetime,price,note")
    rows = data.splitlines()
    rows[1] = rows[1].split(",")[0] + ',,"quoted\nextra info"'
    study = make_study({"ida": ("multiline.csv", "\n".join(rows).encode())})
    issue = study.preview["issues"][0]
    assert (issue["row"], issue["endRow"]) == (2, 3)


def test_missing_days_have_named_market_and_file(csv_prices):
    study = make_study({"ida": ("auction.csv", csv_prices()),
                        "idc": ("continuous.csv", csv_prices(days=2))})
    issue = next(i for i in study.preview["issues"] if i["code"] == "missing_day")
    assert (issue["market"], issue["filename"], issue["date"]) == ("ida", "auction.csv", "2025-01-02")


def test_clock_change_day_with_missing_price_does_not_block_other_days(csv_prices):
    rows = csv_prices(day="2025-03-30", days=2).decode().splitlines()
    rows[1] = rows[1].split(",")[0] + ","
    study = make_study({"ida": ("dst.csv", "\n".join(rows).encode())})
    assert study.preview["includedDates"] == ["2025-03-31"]
    assert study.preview["issueCount"] == 1


def test_extreme_date_range_is_diagnosed_without_building_huge_calendar(csv_prices):
    data = csv_prices() + b"2100-01-01T00:00,1\n"
    study = make_study({"ida": ("wrong-year.csv", data)})
    assert not study.preview["canRun"]
    assert any(i["code"] == "date_range" for i in study.preview["issues"])
