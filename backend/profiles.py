"""Versioned, local hourly profile catalog."""
from __future__ import annotations

import csv
import gzip
import math
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path

import numpy as np

UTC = timezone.utc
HOUR = timedelta(hours=1)
DATA = Path(__file__).with_name("profile_data")
TECHNOLOGIES = {
    "industrial": ("60", "Industrial rooftop"),
    "residential": ("61", "Residential rooftop"),
    "fixed": ("62", "Utility fixed-tilt"),
    "tracking": ("63", "Utility single-axis tracking"),
}
PV_SOURCE = {
    "name": "Copernicus Climate Change Service / ECMWF and ENTSO-E",
    "version": "PECD v4.2 FV1 · ERA5 historical reanalysis · Czechia (NUTS 0)",
    "url": "https://doi.org/10.24381/cds.f323c5ec",
    "license": "CC BY 4.0",
    "unit": "MW/MWp",
}
LOAD_SOURCE = {
    "name": "Fritz Braeuer · 30 German industrial site profiles, 2017",
    "url": "https://doi.org/10.5281/zenodo.3899018",
    "license": "CC BY 4.0",
    "sourceMd5": "a79655288e18f84dddb242134353ab2f",
    "notes": "Interval ends interpreted in Europe/Berlin. Both fall-back occurrences are retained. "
    "Non-existent spring-forward intervals excluded. 25 missing year-end hours use the previous "
    "week at the same hour. Local New Year's first hour wraps to the last UTC hour of the template.",
}


def year_start(year):
    return datetime(year, 1, 1, tzinfo=UTC)


def year_hours(year):
    return (year_start(year + 1) - year_start(year)) // HOUR


def utc_timestamp(value):
    stamp = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    return stamp.replace(tzinfo=UTC) if stamp.tzinfo is None else stamp.astimezone(UTC)


def validate_pv_rows(rows, year):
    tokens = []
    start = year_start(year)
    for index, (stamp, token) in enumerate(rows):
        if stamp != start + index * HOUR:
            raise ValueError(f"Missing, duplicate or off-grid PV timestamp near {stamp.isoformat()}.")
        factor = float(token)
        if not math.isfinite(factor) or factor < 0:
            raise ValueError(f"Invalid capacity factor at {stamp.isoformat()}.")
        tokens.append(token.strip())
    if len(tokens) != year_hours(year):
        raise ValueError(f"Expected {year_hours(year)} hourly values in {year}, got {len(tokens)}.")
    return tokens


class ProfileCatalog:
    def __init__(self, path=DATA):
        self.path = Path(path)

    def years(self):
        available = [{int(p.name.split('.')[0].rsplit('-', 1)[-1])
                      for p in self.path.glob(f'pv-{tech}-[0-9][0-9][0-9][0-9].csv.gz')}
                     for tech in TECHNOLOGIES]
        return sorted(set.intersection(*available))[-10:]

    def pv_path(self, tech, year):
        if tech not in TECHNOLOGIES or year not in self.years():
            raise KeyError(f"Czech PV profile for {tech} / {year} is unavailable.")
        return self.path / f"pv-{tech}-{year}.csv.gz"

    @lru_cache(maxsize=48)
    def pv(self, tech, year):
        path = self.pv_path(tech, year)
        with gzip.open(path, "rt", newline="") as source:
            rows = csv.DictReader(source)
            values = validate_pv_rows(((utc_timestamp(r["datetime"]), r["capacity_factor"]) for r in rows), year)
        array = np.array(values, dtype=float)
        array.flags.writeable = False
        return array

    @lru_cache(maxsize=4)
    def loads(self):
        with np.load(self.path / "load-de-2017.npz", allow_pickle=False) as pack:
            sites = tuple(pack["sites"].tolist())
            hourly = pack["hourly"]
        if (len(sites) != 30 or len(set(sites)) != 30 or hourly.shape != (30, year_hours(2017))
                or not np.isfinite(hourly).all() or (hourly < 0).any() or (hourly.sum(axis=1) <= 0).any()):
            raise ValueError("The local German load catalog is invalid.")
        hourly.flags.writeable = False
        return dict(zip(sites, hourly, strict=True))

    def metadata(self):
        return {
            "years": self.years(),
            "targetYears": [2016, 2025],
            "technologies": [{"id": tech, "label": label} for tech, (_, label) in TECHNOLOGIES.items()],
            "pvSource": PV_SOURCE, "loadSource": LOAD_SOURCE,
            "loadSites": list(self.loads()) if (self.path / "load-de-2017.npz").is_file() else [],
        }


def replay_load(hourly, year, annual_mwh):
    """Keep each source hour, repeat Feb 28 on a leap day, then scale annual energy."""
    extra = (31 + 28) * 24
    if year_hours(year) > len(hourly):
        hourly = np.concatenate((hourly[:extra], hourly[extra - 24:extra], hourly[extra:]))
    return hourly * (annual_mwh / hourly.sum())
