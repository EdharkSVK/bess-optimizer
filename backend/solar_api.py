"""Profile and solar-study API routes on the local optimizer service."""
from __future__ import annotations

import gzip
import time
from datetime import datetime
from typing import Literal
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from fastapi.responses import StreamingResponse
from pydantic import Field

from .btm import BtmRequest, Inputs, candidate_sizes, evaluate, run_btm
from .engine import CalculationError, solver_info
from .hybrid import HybridRequest, hybrid_day, new_solver, prepare_hybrid, pv_quarters, run_hybrid
from .profiles import ProfileCatalog, replay_load


class BtmDetail(Inputs):
    candidate: int = Field(ge=0)
    year: int
    site: str


class HybridDetail(Inputs):
    year: int
    date: str


def register_solar_routes(app, profile_path, lock, studies, runs, cleanup, enqueue):
    catalog = ProfileCatalog() if profile_path is None else ProfileCatalog(profile_path)

    def get_pv(tech, year):
        try:
            return catalog.pv(tech, year)
        except KeyError as exc:
            raise HTTPException(404, detail=exc.args[0]) from exc
        except (OSError, ValueError) as exc:
            raise HTTPException(503, detail=f"Czech PV catalog error: {exc}") from exc

    def get_context(run_id, kind):
        with lock:
            cleanup()
            record = runs.get(run_id)
            if not record or record.get("kind") != kind or record["status"] != "completed":
                raise HTTPException(404, detail="Completed solar study unavailable. Run the study again.")
            record["touched"] = time.monotonic()
            return record["_context"]

    @app.get("/api/profiles")
    def profiles():
        try:
            return catalog.metadata()
        except (ValueError, OSError) as exc:
            raise HTTPException(503, detail=f"Profile catalog error: {exc}") from exc

    @app.get("/api/profiles/pv/{tech}/{year}")
    def pv_profile(tech: Literal["residential", "industrial", "fixed", "tracking"], year: int):
        values = get_pv(tech, year)
        return {"technology": tech, "year": year, "start": datetime(year, 1, 1).isoformat() + "Z",
                "fullLoadHours": float(values.sum()), "capacityFactors": values.tolist()}

    @app.get("/api/profiles/pv/{tech}/{year}/csv")
    def pv_csv(tech: Literal["residential", "industrial", "fixed", "tracking"], year: int):
        get_pv(tech, year)
        path = catalog.pv_path(tech, year)

        def csv_chunks():
            with gzip.open(path, "rb") as stream:
                while chunk := stream.read(64 * 1024):
                    yield chunk

        return StreamingResponse(csv_chunks(), media_type="text/csv",
                                 headers={"Content-Disposition": f'attachment; filename="cz-pv-{tech}-{year}.csv"'})

    @app.post("/api/btm/runs", status_code=202)
    def start_btm(body: BtmRequest):
        try:
            metadata = catalog.metadata()
        except (KeyError, OSError, ValueError) as exc:
            raise HTTPException(503, detail=f"Profile catalog error: {exc}") from exc
        available_years, available_sites = metadata["years"], metadata["loadSites"]
        if not available_years or not available_sites:
            raise HTTPException(503, detail="BtM requires the Czech PV and German load catalogs. See profile setup in README.")
        years = sorted(set(body.years or available_years))
        sites = tuple(dict.fromkeys(body.sites or available_sites))
        if not set(years) <= set(available_years) or not set(sites) <= set(available_sites):
            raise HTTPException(422, detail="Select years and sites from the local profile catalog.")
        return enqueue("btm", len(years) * len(sites), lambda progress: run_btm(body, catalog, years, sites, progress),
                       (body, years, sites))

    @app.post("/api/btm/runs/{run_id}/detail", status_code=202)
    def btm_detail(run_id: str, detail: BtmDetail):
        request, years, sites = get_context(run_id, "btm")
        candidates = candidate_sizes(request)
        if detail.year not in years or detail.site not in sites or detail.candidate >= len(candidates):
            raise HTTPException(422, detail="The selected scenario was not included in this study.")

        def work(_progress):
            factor = catalog.pv(request.technology, detail.year)
            load = replay_load(catalog.loads()[detail.site], detail.year, request.annualLoadMWh)
            return evaluate(request, candidates[detail.candidate][1], detail.year, load, factor, detail=True)

        return enqueue("detail", 1, work)

    @app.post("/api/hybrid/runs", status_code=202)
    def start_hybrid(body: HybridRequest):
        with lock:
            cleanup()
            record = studies.get(body.studyId)
            if not record:
                raise HTTPException(404, detail="Study expired or service restarted. Validate the market files again.")
            record["touched"] = time.monotonic()
            study = record["study"]
        try:
            scenarios, coverage = prepare_hybrid(body, study, catalog)
            solver_info()
        except ValueError as exc:
            raise HTTPException(422, detail=str(exc)) from exc
        except CalculationError as exc:
            raise HTTPException(503, detail=str(exc)) from exc
        return enqueue("hybrid", sum(len(days) for days in scenarios.values()),
                       lambda progress: run_hybrid(body, study, catalog, scenarios, coverage, progress),
                       (body, study, scenarios))

    @app.post("/api/hybrid/runs/{run_id}/detail", status_code=202)
    def hybrid_detail(run_id: str, detail: HybridDetail):
        request, study, scenarios = get_context(run_id, "hybrid")
        if detail.date not in scenarios.get(detail.year, ()):
            raise HTTPException(422, detail="The selected delivery date was not included in this scenario.")

        def work(_progress):
            pv = pv_quarters(catalog, request, detail.year, detail.date, ZoneInfo(study.timezone))
            return hybrid_day(request, study.days[detail.date], pv, new_solver(), detail.date, detail=True)

        return enqueue("detail", 1, work)
