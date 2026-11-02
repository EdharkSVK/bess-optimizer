"""Single-process, local-only API and static React host."""
from __future__ import annotations

import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal
from uuid import uuid4

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict

from .domain import Battery, InputError, make_study
from .engine import CalculationError, optimize, solver_info

TTL = 3600
LOGGER = logging.getLogger(__name__)


class RunRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    studyId: str
    battery: Battery


def create_app(dist: Path | None = None):
    lock = threading.RLock()
    studies, runs = {}, {}

    @asynccontextmanager
    async def lifespan(app):
        app.state.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="bess")
        yield
        app.state.pool.shutdown(wait=False, cancel_futures=True)

    app = FastAPI(title="FlexOptima three-market wrapper", lifespan=lifespan)
    # Exposed only for deterministic lifecycle/expiry tests; there is no persistence.
    app.state.studies, app.state.runs, app.state.lock = studies, runs, lock

    def cleanup():
        now = time.monotonic()
        for key, record in list(studies.items()):
            if now - record["touched"] > TTL:
                del studies[key]
        for key, record in list(runs.items()):
            if record["status"] in ("completed", "failed") and now - record["touched"] > TTL:
                del runs[key]

    @app.get("/api/health")
    def health():
        try:
            return {"ready": True, "solver": solver_info()}
        except Exception as exc:
            return JSONResponse(status_code=503, content={"ready": False, "error": str(exc)})

    @app.post("/api/studies")
    async def create_study(
        timezone: str = Form("Europe/Prague"),
        dayAheadProduct: Literal["auto", "60", "15"] = Form("auto"),
        daa: UploadFile | None = File(None),
        ida: UploadFile | None = File(None),
        idc: UploadFile | None = File(None),
    ):
        files = {}
        try:
            for market, upload in (("daa", daa), ("ida", ida), ("idc", idc)):
                if upload is not None:
                    data = await upload.read(32 * 1024 * 1024 + 1)
                    if len(data) > 32 * 1024 * 1024:
                        raise InputError(f"{market.upper()}: maximum file size is 32 MiB.")
                    files[market] = (upload.filename or f"{market}.csv", data)
            # Parsing/calendar work runs off the event loop, including annual files.
            from starlette.concurrency import run_in_threadpool
            study = await run_in_threadpool(make_study, files, timezone, dayAheadProduct)
        except InputError as exc:
            raise HTTPException(422, detail=str(exc)) from exc
        finally:
            for upload in (daa, ida, idc):
                if upload is not None:
                    await upload.close()
        with lock:
            cleanup()
            studies[study.id] = {"study": study, "touched": time.monotonic()}
        return {"studyId": study.id, "preview": study.preview}

    def execute(run_id, study, battery):
        with lock:
            runs[run_id].update(status="running", touched=time.monotonic())

        def progress(update):
            with lock:
                runs[run_id].update(update, touched=time.monotonic())
        try:
            result = optimize(study, battery, progress)
        except Exception as exc:
            LOGGER.exception("Calculation failed for run %s", run_id)
            with lock:
                runs[run_id].update(status="failed", error=str(exc), touched=time.monotonic())
        else:
            with lock:
                runs[run_id].update(status="completed", result=result, currentMarket=None,
                                    completedDays=len(study.days), touched=time.monotonic())

    @app.post("/api/runs", status_code=202)
    def start_run(body: RunRequest):
        try:
            solver_info()
        except CalculationError as exc:
            raise HTTPException(503, detail=str(exc)) from exc
        with lock:
            cleanup()
            record = studies.get(body.studyId)
            if not record:
                raise HTTPException(404, detail="Study expired or service restarted. Validate the files again.")
            study = record["study"]
            if not study.days:
                raise HTTPException(422, detail="No common complete days are available to calculate.")
            # One active run also bounds memory/queue use for this local application.
            if any(r["status"] in ("queued", "running") for r in runs.values()):
                raise HTTPException(409, detail="Another calculation is running. Wait for it to finish.")
            record["touched"] = time.monotonic()
            run_id = str(uuid4())
            runs[run_id] = {"runId": run_id, "status": "queued", "completedDays": 0,
                           "totalDays": len(study.days), "currentDate": None, "currentMarket": None,
                           "error": None, "touched": time.monotonic()}
            app.state.pool.submit(execute, run_id, study, body.battery)
        return {"runId": run_id}

    @app.get("/api/runs/{run_id}")
    def get_run(run_id: str):
        with lock:
            cleanup()
            record = runs.get(run_id)
            if not record:
                raise HTTPException(404, detail="Run expired or service restarted. Validate the files and run again.")
            return {key: value for key, value in record.items() if key != "touched"}

    static_dir = dist if dist is not None else Path(__file__).resolve().parent.parent / "dist"
    if static_dir.is_dir():
        # Register /api routes first; unknown API paths must never return index.html.
        @app.api_route("/api/{path:path}", methods=["GET", "POST", "PUT", "DELETE"])
        def unknown_api(path: str):
            raise HTTPException(404, detail="Unknown API endpoint.")
        app.mount("/", StaticFiles(directory=static_dir, html=True), name="ui")
    return app


app = create_app()
