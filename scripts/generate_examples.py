"""Regenerate the three CSV examples from the untouched upstream notebook."""
import ast
import csv
import json
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

root = Path(__file__).resolve().parent.parent
notebook = json.loads((root / "example.ipynb").read_text(encoding="utf-8"))
prices = {}
for cell in notebook["cells"]:
    if cell["cell_type"] != "code":
        continue
    for node in ast.parse("".join(cell["source"])).body:
        if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name):
            name = node.targets[0].id
            if name in ("daa_price_vector", "ida_price_vector", "idc_price_vector"):
                prices[name[:3]] = ast.literal_eval(node.value)
directory = root / "public/examples"
directory.mkdir(parents=True, exist_ok=True)
start = datetime(2025, 1, 1, tzinfo=ZoneInfo("Europe/Prague"))
for market, values in prices.items():
    step = 60 if market == "daa" else 15
    values = values[::4] if market == "daa" else values
    with (directory / f"{market}.csv").open("w", newline="", encoding="utf-8") as stream:
        writer = csv.writer(stream)
        writer.writerow(["datetime", "price"])
        writer.writerows(((start + timedelta(minutes=step * i)).isoformat(), p) for i, p in enumerate(values))
