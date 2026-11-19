"""Download original Czech PV source archives sequentially from Copernicus CDS."""
import argparse
from pathlib import Path
from zipfile import is_zipfile

from backend.profiles import TECHNOLOGIES

CDS_URL = "https://cds.climate.copernicus.eu/api"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start", type=int, default=2016)
    parser.add_argument("--end", type=int, default=2025)
    parser.add_argument("--batch-years", type=int, default=10)
    parser.add_argument("--output", type=Path, default=Path(".tools/profile-source"))
    parser.add_argument("--credentials", type=Path, default=Path(".api-credentials.local"))
    args = parser.parse_args()
    if args.start > args.end:
        parser.error("Start year must precede or equal end year.")
    if args.batch_years < 1:
        parser.error("Batch size must be positive.")

    import cdsapi

    credentials = dict(line.split("=", 1) for line in args.credentials.read_text().splitlines()
                       if line and not line.startswith("#"))
    if credentials.get("CDSAPI_URL", "").rstrip("/") != CDS_URL or not credentials.get("CDSAPI_KEY"):
        parser.error("Supply CDSAPI_URL and CDSAPI_KEY for the official Copernicus Climate Data Store.")
    client = cdsapi.Client(url=CDS_URL, key=credentials["CDSAPI_KEY"], quiet=True,
                           progress=False, timeout=60, retry_max=3)
    args.output.mkdir(parents=True, exist_ok=True)
    for year in range(args.end, args.start - 1, -args.batch_years):
        first = max(args.start, year - args.batch_years + 1)
        target = args.output / f"pecd-60+61+62+63-{first}-{year}.zip"
        if is_zipfile(target):
            continue
        print(f"Requesting PECD v4.2 FV1 for {first}–{year}", flush=True)
        partial = target.with_suffix(".part")
        try:
            client.retrieve("sis-energy-pecd", {
                "pecd_version": "pecd4_2", "file_version": ["fv1"], "temporal_period": ["historical"],
                "origin": ["era5_reanalysis"], "spatial_resolution": ["nuts_0"],
                "technology": [code for code, _ in TECHNOLOGIES.values()],
                "variable": ["solar_photovoltaic_generation_capacity_factor"],
                "year": [str(item) for item in range(first, year + 1)],
            }, str(partial))
        except Exception as exc:
            message = str(exc).replace(credentials["CDSAPI_KEY"], "[redacted]")
            raise SystemExit(message) from None
        if not is_zipfile(partial):
            raise SystemExit(f"CDS response for {first}–{year} was not a ZIP archive.")
        partial.replace(target)


if __name__ == "__main__":
    main()
