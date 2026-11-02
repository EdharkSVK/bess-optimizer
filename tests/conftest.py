import csv
import io
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest


def price_csv(day="2025-01-01", minutes=15, prices=None, days=1, aware=True):
    zone = ZoneInfo("Europe/Prague")
    start = datetime.fromisoformat(day).replace(tzinfo=zone)
    end = start + timedelta(days=days)
    now = start.astimezone(timezone.utc)
    stream = io.StringIO(newline="")
    writer = csv.writer(stream)
    writer.writerow(["datetime", "price"])
    i = 0
    while now < end.astimezone(timezone.utc):
        local = now.astimezone(zone)
        price = prices[i % len(prices)] if prices is not None else (10 if local.hour < 12 else 100)
        writer.writerow([(local if aware else local.replace(tzinfo=None)).isoformat(), price])
        now += timedelta(minutes=minutes)
        i += 1
    return stream.getvalue().encode()


@pytest.fixture
def csv_prices():
    return price_csv
