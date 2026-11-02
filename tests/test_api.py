import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import backend.app as api


@pytest.fixture
def client():
    with TestClient(api.create_app(dist=Path("nonexistent-test-dist"))) as session:
        yield session


def wait_for_run(client, run_id):
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        response = client.get(f"/api/runs/{run_id}")
        assert response.status_code == 200
        data = response.json()
        if data["status"] in ("completed", "failed"):
            return data
        time.sleep(.025)
    pytest.fail("Run did not complete")


def test_upload_run_and_reconciliation(client, csv_prices):
    response = client.post("/api/studies", files={"idc": ("continuous.csv", csv_prices(), "text/csv")})
    assert response.status_code == 200
    study = response.json()
    assert study["preview"]["modelledDays"] == 1
    response = client.post("/api/runs", json={"studyId": study["studyId"], "battery": {}})
    assert response.status_code == 202
    run = wait_for_run(client, response.json()["runId"])
    assert run["status"] == "completed", run
    assert run["completedDays"] == run["totalDays"] == 1
    result = run["result"]
    assert result["totalRevenue"] == pytest.approx(sum(row["revenue"] for row in result["daily"][0]["schedule"]))
    assert result["marketRevenue"]["daa"] is None
    assert result["metadata"]["battery"]["wearCostPerMWh"] == 20
    assert result["metadata"]["battery"]["maxCyclesPerDay"] is None
    assert result["wearCost"] == pytest.approx(result["cycles"]*4*20)
    assert result["wearAdjustedMargin"] == pytest.approx(result["totalRevenue"]-result["wearCost"])
    assert result["averageCyclesPerDay"] == pytest.approx(result["cycles"])
    assert client.get("/api/health").json()["ready"]


def test_no_upload_invalid_inputs_and_no_overlap(client, csv_prices):
    assert client.post("/api/studies").status_code == 422
    assert client.post("/api/runs", json={"studyId": "x", "battery": {"capacityMWh": 0}}).status_code == 422
    assert client.post("/api/runs", json={"studyId": "x", "battery": {"wearCostPerMWh": -1}}).status_code == 422
    assert client.post("/api/runs", json={"studyId": "x", "battery": {}}).status_code == 404
    study = client.post("/api/studies", files={"ida": ("partial.csv", b"datetime,price\n2025-01-01T00:00,20\n")}).json()
    assert not study["preview"]["canRun"]
    assert client.post("/api/runs", json={"studyId": study["studyId"], "battery": {}}).status_code == 422


def test_dirty_upload_optimizes_only_valid_days_and_preserves_report(client, csv_prices):
    rows = csv_prices(days=2).decode().splitlines()
    rows[10] = rows[10].split(",")[0] + ","
    rows[11] = rows[11].split(",")[0] + ",NaN"
    upload = client.post("/api/studies", files={"ida": ("dirty.csv", "\n".join(rows).encode())})
    assert upload.status_code == 200
    study = upload.json()
    assert study["preview"]["modelledDays"] == study["preview"]["excludedDays"] == 1
    assert study["preview"]["issueCount"] == 2
    run_id = client.post("/api/runs", json={"studyId": study["studyId"], "battery": {}}).json()["runId"]
    run = wait_for_run(client, run_id)
    assert run["status"] == "completed", run
    result = run["result"]
    assert [day["date"] for day in result["daily"]] == ["2025-01-02"]
    assert result["coverage"]["issues"] == study["preview"]["issues"]
    clean = client.post("/api/studies", files={"ida": ("clean.csv", csv_prices(day="2025-01-02"))}).json()
    clean_run_id = client.post("/api/runs", json={"studyId": clean["studyId"], "battery": {}}).json()["runId"]
    baseline = wait_for_run(client, clean_run_id)["result"]
    for metric in ("totalRevenue", "wearCost", "wearAdjustedMargin", "cycles", "averageCyclesPerDay"):
        assert result[metric] == pytest.approx(baseline[metric])


def test_unreadable_market_returns_report_but_cannot_run(client, csv_prices):
    response = client.post("/api/studies", files={"ida": ("bad.csv", b"wrong,header\n1,2"),
                                                  "idc": ("good.csv", csv_prices())})
    assert response.status_code == 200
    study = response.json()
    assert study["preview"]["blockingFiles"] == ["ida"]
    assert study["preview"]["markets"] == ["ida", "idc"]
    assert not study["preview"]["canRun"]
    assert client.post("/api/runs", json={"studyId": study["studyId"], "battery": {}}).status_code == 422


def test_failed_run_has_no_partial_result(client, csv_prices, monkeypatch):
    def fail(*args):
        raise RuntimeError("2025-01-01 / IDC: solver timeout")
    monkeypatch.setattr(api, "optimize", fail)
    study = client.post("/api/studies", files={"idc": ("x.csv", csv_prices())}).json()
    run_id = client.post("/api/runs", json={"studyId": study["studyId"], "battery": {}}).json()["runId"]
    run = wait_for_run(client, run_id)
    assert run["status"] == "failed"
    assert "IDC" in run["error"] and "result" not in run


def test_expiry_and_restart(client, csv_prices):
    study = client.post("/api/studies", files={"ida": ("x.csv", csv_prices())}).json()
    client.app.state.studies[study["studyId"]]["touched"] -= api.TTL + 1
    assert client.post("/api/runs", json={"studyId": study["studyId"], "battery": {}}).status_code == 404
    with TestClient(api.create_app(dist=Path("nonexistent-test-dist"))) as restarted:
        assert restarted.get("/api/runs/old-run").status_code == 404


def test_health_missing_solver(client, monkeypatch):
    def fail():
        raise api.CalculationError("GLPK not installed")
    monkeypatch.setattr(api, "solver_info", fail)
    assert client.get("/api/health").status_code == 503
    assert client.post("/api/runs", json={"studyId": "x", "battery": {}}).status_code == 503


def test_only_one_active_run(client, csv_prices):
    study = client.post("/api/studies", files={"ida": ("x.csv", csv_prices())}).json()
    client.app.state.runs["other"] = {"status": "running", "touched": time.monotonic()}
    response = client.post("/api/runs", json={"studyId": study["studyId"], "battery": {}})
    assert response.status_code == 409
    del client.app.state.runs["other"]


def test_completed_results_expire(client):
    client.app.state.runs["expired"] = {"status": "completed", "touched": time.monotonic() - api.TTL - 1}
    assert client.get("/api/runs/expired").status_code == 404


def test_static_files_and_unknown_api_paths(tmp_path):
    (tmp_path / "index.html").write_text("<html>FlexOptima</html>")
    with TestClient(api.create_app(dist=tmp_path)) as session:
        assert "FlexOptima" in session.get("/").text
        assert session.get("/api/unknown").status_code == 404
        assert session.get("/docs").status_code == 200
