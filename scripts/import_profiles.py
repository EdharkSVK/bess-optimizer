"""Prepare the local app catalog from original PECD archives and Braeuer CSV."""
import argparse
import csv
import gzip
import hashlib
import io
import os
from pathlib import Path
from zipfile import ZipFile
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import numpy as np

from backend.profiles import DATA, LOAD_SOURCE, TECHNOLOGIES, UTC, utc_timestamp, validate_pv_rows, year_start


def import_pv(directory):
    technologies = {code: tech for tech, (code, _) in TECHNOLOGIES.items()}
    for archive in sorted(directory.glob("pecd-*.zip")):
        with ZipFile(archive) as pack:
            for member in pack.namelist():
                if not member.lower().endswith(".csv"):
                    continue
                parts = Path(member).stem.upper().split("_")
                if (len(parts) < 22 or parts[:2] != ["H", "ERA5"] or parts[4] != "SPV"
                        or parts[7] != "NUT0" or parts[13] != "COM" or parts[16] not in technologies
                        or parts[-2:] != ["PECD4.2", "FV1"]):
                    raise ValueError(f"Unexpected PECD source file {member}.")
                tech = technologies[parts[16]]
                year = int(parts[8][1:5])
                with pack.open(member) as file:
                    lines = io.TextIOWrapper(file, encoding="utf-8-sig", newline="")
                    reader = csv.DictReader(line for line in lines if not line.startswith("#") and line.strip())
                    if not reader.fieldnames or not {"Date", "CZ"} <= set(reader.fieldnames):
                        raise ValueError(f"Expected Date and CZ columns in {member}.")
                    rows = [(utc_timestamp(row["Date"]), row["CZ"]) for row in reader]
                values = validate_pv_rows(rows, year)
                name = DATA / f"pv-{tech}-{year}.csv.gz"
                temp = name.with_suffix(".part")
                with temp.open("wb") as raw, gzip.GzipFile(fileobj=raw, filename="", mode="wb", mtime=0) as zipped:
                    text = io.TextIOWrapper(zipped, encoding="utf-8", newline="")
                    writer = csv.writer(text, lineterminator="\n")
                    writer.writerow(["datetime", "capacity_factor"])
                    for (stamp, _), value in zip(rows, values, strict=True):
                        writer.writerow([stamp.isoformat().replace("+00:00", "Z"), value])
                    text.flush()
                    text.detach()
                os.replace(temp, name)
                print(f"{tech} {year}: {len(values)} hours, {sum(map(float, values)):.1f} full-load hours")


def german_loads(path):
    if hashlib.md5(path.read_bytes()).hexdigest() != LOAD_SOURCE["sourceMd5"]:
        raise ValueError("German source checksum differs from Zenodo record 3899018.")
    zone = ZoneInfo("Europe/Berlin")
    step = timedelta(minutes=15)
    observed = {}
    missing = set()
    spring = 0
    with path.open(newline="", encoding="utf-8-sig") as stream:
        reader = csv.reader(stream, delimiter=";")
        next(reader)
        time_header, *sites = next(reader)
        if time_header != "Time stamp" or len(sites) != 30:
            raise ValueError("Unexpected German load file headers.")
        for raw_stamp, *values in reader:
            local = datetime.strptime(raw_stamp.removesuffix(" b"), "%d.%m.%Y %H:%M:%S") - step
            instant = local.replace(tzinfo=zone, fold=int(raw_stamp.endswith(" b"))).astimezone(UTC)
            if instant.astimezone(zone).replace(tzinfo=None) != local:
                spring += 1
                continue
            if instant in observed or instant in missing:
                raise ValueError(f"Duplicate German load interval {instant}.")
            if all(not value for value in values):
                missing.add(instant)
            else:
                power = np.array(values, dtype=float)
                if len(power) != 30 or not np.isfinite(power).all() or (power < 0).any():
                    raise ValueError(f"Invalid German load interval {instant}.")
                observed[instant] = power
    if len(missing) != 100 or spring != 4:
        raise ValueError("Unexpected missing periods or clock changes in German data.")
    start = year_start(2017) - timedelta(hours=1)
    expected = [start + i * step for i in range(365 * 96)]
    if set(expected) != observed.keys() | missing:
        raise ValueError("German load intervals do not match the 2017 delivery calendar.")
    week = timedelta(days=7)
    quarters = np.stack([observed[t] if t in observed else observed[t - week] for t in expected])
    # The first local hour falls in the previous UTC year. Wrap it as a cyclic template.
    quarters = np.concatenate((quarters[4:], quarters[:4]))
    hourly = quarters.reshape(-1, 4, 30).sum(axis=1).T / 4000
    np.testing.assert_allclose(hourly.sum(axis=1), quarters.sum(axis=0) / 4000, rtol=1e-12)
    return sites, hourly


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pv-archives", type=Path)
    parser.add_argument("--german-csv", type=Path)
    args = parser.parse_args()
    DATA.mkdir(parents=True, exist_ok=True)
    if args.pv_archives:
        import_pv(args.pv_archives)
    if args.german_csv:
        sites, hourly = german_loads(args.german_csv)
        temporary = DATA / "load-de-2017.part"
        with temporary.open("wb") as output:
            np.savez_compressed(output, sites=sites, hourly=hourly)
        temporary.replace(DATA / "load-de-2017.npz")
        print(f"German load catalog: {len(sites)} sites × {hourly.shape[1]} hours")


if __name__ == "__main__":
    main()
