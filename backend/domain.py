"""Input contracts and calendar-aware CSV validation (no solver dependency)."""
from __future__ import annotations

import csv
import hashlib
import io
import math
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from typing import Literal
from uuid import uuid4
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field

MARKETS = ("daa", "ida", "idc")
UTC = timezone.utc
Product = Literal["auto", "60", "15"]


class InputError(ValueError):
    pass


class Battery(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid", allow_inf_nan=False)
    capacityMWh: float = Field(default=4, gt=0)
    maxPowerMW: float = Field(default=1, gt=0)
    roundtripEfficiency: float = Field(default=0.85, gt=0, le=1)
    wearCostPerMWh: float = Field(default=20., ge=0)
    # Optional contractual restriction, independent of the economic wear penalty.
    maxCyclesPerDay: float | None = Field(default=None, ge=0)


@dataclass(frozen=True)
class MarketDay:
    prices: tuple[float, ...]
    product_minutes: int


@dataclass(frozen=True)
class Study:
    id: str
    timezone: str
    days: dict[str, dict[str, MarketDay]]
    preview: dict


def clock_change(day: date, zone: ZoneInfo) -> bool:
    start = datetime.combine(day, time(), zone).astimezone(UTC)
    end = datetime.combine(day + timedelta(days=1), time(), zone).astimezone(UTC)
    return end - start != timedelta(hours=24)


@dataclass
class ParsedPrices:
    groups: dict[date, list[tuple[datetime, float]]]
    observed: dict[date, dict[datetime, int]]
    invalid_days: set[date]
    issues: list[dict]
    summary: dict
    blocked: bool = False


def diagnostic(market, filename, code, message, *, day=None, row=None, end_row=None,
               timestamp=None, price=None, related_row=None, scope="day", missing=None):
    return {"market": market, "filename": filename, "code": code, "message": message,
            "date": day.isoformat() if day else None, "row": row, "endRow": end_row,
            "datetime": timestamp, "price": price, "relatedRow": related_row,
            "scope": scope, "missingTimestamps": missing or []}


def read_prices(market: str, filename: str, data: bytes, zone: ZoneInfo):
    parsed = ParsedPrices({}, {}, set(), [], {
        "market": market, "filename": filename, "rowCount": 0, "validRowCount": 0,
        "firstDate": None, "lastDate": None, "sha256": hashlib.sha256(data).hexdigest(),
    })

    def file_error(code, message, row=None, end_row=None):
        parsed.blocked = True
        parsed.issues.append(diagnostic(market, filename, code, message, row=row,
                                        end_row=end_row, scope="file"))

    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        file_error("encoding", "Cannot read this file as UTF-8. Save the CSV as UTF-8 and upload again.")
        return parsed
    reader = csv.reader(io.StringIO(text, newline=""), strict=True)
    record_start = 1
    try:
        headers = [h.strip().lower() for h in next(reader, [])]
        if len(set(headers)) != len(headers) or not {"datetime", "price"}.issubset(headers):
            file_error("headers", "Expected unique datetime and price columns, separated by commas.", 1)
            return parsed
        instants = {}
        while True:
            record_start = reader.line_num + 1
            try:
                values = next(reader)
            except StopIteration:
                break
            line = reader.line_num
            if not values:
                continue
            row = dict(zip(headers, values))
            if len(values) > len(headers):
                row[None] = values[len(headers):]
            if None not in row and all(not (value or "").strip() for value in row.values()):
                continue
            parsed.summary["rowCount"] += 1
            raw = (row.get("datetime") or "").strip()
            raw_price = (row.get("price") or "").strip()
            local = None
            problems = []
            try:
                if len(raw) < 16 or raw[10] not in ("T", " "):
                    raise ValueError("expected an ISO delivery start, including date and time")
                stamp = datetime.fromisoformat(raw.replace("Z", "+00:00"))
                local = stamp.replace(tzinfo=zone) if stamp.tzinfo is None else stamp.astimezone(zone)
                # Ensure conversion is representable before recording a date.
                instant = local.astimezone(UTC)
                if local.year == 9999:
                    raise ValueError("delivery year is outside the supported calendar range")
            except (ValueError, OverflowError) as exc:
                local = None
                problems.append(("datetime", f"Invalid or missing delivery datetime: {exc}."))
            price = None
            try:
                if not raw_price:
                    raise ValueError("price is missing")
                price = float(raw_price)
                if not math.isfinite(price):
                    raise ValueError("price must be finite")
            except (ValueError, OverflowError) as exc:
                problems.append(("price", f"Invalid price: {exc}. Use a number with a decimal point."))
            if None in row:
                problems.append(("columns", f"Expected {len(headers)} columns, found {len(values)}; use comma separators and decimal points. Extra values: {row[None]!r}."))
            day = local.date() if local else None
            if local:
                parsed.groups.setdefault(day, [])
                observed = parsed.observed.setdefault(day, {})
                if local.second or local.microsecond or local.minute % 15:
                    problems.append(("interval", "Delivery starts must be on a quarter-hour boundary."))
                # Repeated naive times are expected on excluded clock-change days.
                if not clock_change(day, zone) and instant in instants:
                    problems.append(("duplicate", f"Duplicate delivery instant; first occurrence is row {instants[instant]}."))
                observed.setdefault(local, record_start)
                first_row = instants.setdefault(instant, record_start)
            for code, message in problems:
                parsed.issues.append(diagnostic(market, filename, code, message, day=day,
                    row=record_start, end_row=line, timestamp=raw, price=raw_price,
                    related_row=first_row if code == "duplicate" else None,
                    scope="day" if day else "row"))
            if problems:
                if day:
                    parsed.invalid_days.add(day)
            else:
                parsed.groups[day].append((local, price))
                parsed.summary["validRowCount"] += 1
    except csv.Error as exc:
        # Quoting errors can swallow following records. Do not guess where rows resume.
        file_error("csv_structure", f"Invalid CSV: {exc}. Record boundaries cannot be trusted; correct this file or remove it.",
                   record_start, reader.line_num)
    if parsed.groups:
        parsed.summary.update(firstDate=min(parsed.groups).isoformat(), lastDate=max(parsed.groups).isoformat())
    elif not parsed.blocked:
        file_error("no_dates", "No readable delivery dates found. Correct this file or remove it.")
    return parsed


def normalize_day(market: str, rows: list, day: date, zone: ZoneInfo, product: Product):
    rows = sorted(rows, key=lambda x: x[0].astimezone(UTC))
    start = datetime.combine(day, time(), zone)

    def matches(minutes: int):
        expected = [start + timedelta(minutes=minutes * i) for i in range(1440 // minutes)]
        return [r[0] for r in rows] == expected

    if market == "daa" and product != "15" and matches(60):
        return MarketDay(tuple(p for _, p in rows for _ in range(4)), 60), None
    if matches(15):
        prices = tuple(p for _, p in rows)
        if market == "daa" and product == "60":
            if any(len(set(prices[i:i + 4])) != 1 for i in range(0, 96, 4)):
                return None, "Hourly-product override requires four identical prices per hour."
            return MarketDay(prices, 60), None
        return MarketDay(prices, 15), None
    expectation = "24 hourly or 96 quarter-hourly" if market == "daa" and product == "auto" else (
        "24 hourly or 96 repeated quarter-hourly" if market == "daa" and product == "60" else "96 quarter-hourly")
    return None, f"{market.upper()}: incomplete/unsupported delivery grid ({len(rows)} rows; expected {expectation})"


def make_study(files: dict[str, tuple[str, bytes]], tz_name="Europe/Prague", product: Product = "auto") -> Study:
    if not files or any(m not in MARKETS for m in files):
        raise InputError("Upload at least one of the three market files.")
    if product not in ("auto", "60", "15"):
        raise InputError("Day-ahead product must be auto, 60 or 15.")
    try:
        zone = ZoneInfo(tz_name)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise InputError("Choose a valid IANA study timezone, for example Europe/Prague.") from exc
    parsed, summaries, normalized, failures, issues = {}, [], {}, {}, []
    for market in MARKETS:
        if market not in files:
            continue
        source = read_prices(market, *files[market], zone)
        parsed[market] = source
        summary = source.summary
        issues.extend(source.issues)
        row_reasons = {}
        for issue in source.issues:
            if issue["date"]:
                row_reasons.setdefault(issue["date"], set()).add(issue["code"])
        normalized[market], failures[market] = {}, {}
        for day, rows in source.groups.items():
            if source.blocked:
                break
            if clock_change(day, zone):
                continue
            observed = source.observed[day]
            cadence = 60 if market == "daa" and product != "15" and (
                (product == "60" and len(observed) <= 24) or
                (product == "auto" and all(t.minute == 0 and t.second == 0 and t.microsecond == 0 for t in observed))
            ) else 15
            start = datetime.combine(day, time(), zone)
            expected = [start + timedelta(minutes=cadence * i) for i in range(1440 // cadence)]
            missing = [t.isoformat() for t in expected if t not in observed]
            if missing:
                issues.append(diagnostic(market, summary["filename"], "missing_intervals",
                    f"Missing {len(missing)} delivery interval(s) on the {cadence}-minute grid.",
                    day=day, missing=missing))
            value, reason = normalize_day(market, rows, day, zone, product)
            if day in source.invalid_days:
                failures[market][day] = f"{market.upper()}: invalid row(s) ({', '.join(sorted(row_reasons[day.isoformat()]))}); see validation issues"
                if missing:
                    failures[market][day] += f" Missing {len(missing)} delivery interval(s)."
            elif value:
                normalized[market][day] = value
            else:
                failures[market][day] = reason
                if not missing:
                    issues.append(diagnostic(market, summary["filename"], "delivery_grid", reason, day=day))
        summary["intervalsMinutes"] = sorted({v.product_minutes for v in normalized[market].values()})
        summaries.append(summary)
    dates = [day for source in parsed.values() for day in source.groups]
    first, last = (min(dates), max(dates)) if dates else (None, None)
    if dates and (last - first).days > 366 * 50:
        for market, source in parsed.items():
            source.blocked = True
            issues.append(diagnostic(market, source.summary["filename"], "date_range",
                f"Combined date coverage spans {first} to {last}, exceeding 50 years. Check the delivery years before running.", scope="file"))
        dates = []
    included, excluded, days = [], [], {}
    for offset in range((last - first).days + 1 if dates else 0):
        day = first + timedelta(days=offset)
        reasons = []
        if clock_change(day, zone):
            reasons.append("Clock-change day: the original model requires 96 quarters")
        else:
            for market, source in parsed.items():
                if source.blocked:
                    reasons.append(f"{market.upper()}: file cannot be read safely; correct it or remove this market")
                elif day not in normalized[market]:
                    reasons.append(failures[market].get(day, f"{market.upper()}: no data for this date"))
                    if day not in source.groups:
                        issues.append(diagnostic(market, source.summary["filename"], "missing_day",
                            "No delivery data for this date.", day=day))
        if reasons:
            excluded.append({"date": day.isoformat(), "reasons": reasons})
        else:
            key = day.isoformat()
            included.append(key)
            days[key] = {m: normalized[m][day] for m in parsed}
    for summary in summaries:
        source = parsed[summary["market"]]
        summary["issueCount"] = sum(i["market"] == summary["market"] for i in issues)
        summary["status"] = "unreadable" if source.blocked else "needs_attention" if summary["issueCount"] else "ready"
    return Study(str(uuid4()), tz_name, days, {
        "timezone": tz_name, "dayAheadProduct": product, "files": summaries,
        "markets": list(parsed), "includedDates": included, "excludedDates": excluded,
        "modelledDays": len(included), "excludedDays": len(excluded), "canRun": bool(included),
        "issues": issues, "issueCount": len(issues),
        "blockingFiles": [m for m, source in parsed.items() if source.blocked],
    })
