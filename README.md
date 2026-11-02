# FlexOptima: historical three-market BESS revenue

Configure a battery and upload **one, two or three separate price CSVs**. The app validates shared delivery dates, then calls the original FlexPower Python optimizer sequentially: day-ahead (DAA), intraday auction (IDA), intraday continuous (IDC/ID1). An absent market is skipped; its stage is never replaced by zero prices.

This is a price-scenario revenue-potential benchmark with perfect knowledge within each selected market stage. It does not forecast prices or simulate orders, liquidity, spreads or execution. Gross trading margin is sales minus purchases. Wear-adjusted margin subtracts an economic wear allowance, before fees and other operating or investment costs. No excluded days are annualized.

## Wear-aware dispatch and physical cycles (wrapper 1.2.0)

The main economic input is **Wear cost (EUR / internal discharged MWh)**, default **20**. This is an illustrative screening assumption, not a verified supplier rate; compare 10/20/40 and calibrate to project degradation/replacement assumptions. Zero restores gross-revenue optimization. No daily cycle cap applies by default. An optional contractual daily limit remains available in advanced battery settings; capacity, power, SOC, efficiency and direction constraints always apply.

Every stage maximizes incremental gross trading margin minus the **change** in expected physical wear. Later closures can save wear and may rationally incur a cash loss smaller than the wear saved. A wear allowance is charged only to the final physical schedule, never to each intermediate plan or offsetting financial trade. One full equivalent cycle of a 4 MWh battery costs EUR 80 at EUR 20/MWh. The original upstream file and fingerprint remain unchanged.

Results separately display gross margin, estimated wear, wear-adjusted margin, internal discharged energy and cycles. Revenue is displayed above physical cycles. Shared controls separate the selected period (all dates or one day/week/month/year) from chart grouping (daily/weekly/monthly/yearly); hover tooltips are synchronized by date across revenue and cycles. The displayed run wear rate comes from that result's battery inputs. Day/week/month/year grouping shows total cycles and average cycles per modelled day. The selected scope also shows the average cycle total per represented grouping period; partial periods are not extrapolated. Zero-cycle modelled days count in averages; excluded dates do not. Filtered summary, daily and quarter-hour exports carry the same economics and physical-cycle totals. A wear allowance is not a cash expense: reconcile it with replacement/augmentation expenditure in a project financial model to avoid double counting.

## Run with Docker Desktop

Start Docker Desktop with Linux containers, then run from this project folder:

```powershell
docker compose up --build -d
```

Open <http://localhost:8082>. The same container serves the React interface and the Python API with GLPK. Host Python and Node installations are unnecessary. The first build downloads images and dependencies.

```powershell
docker compose ps
docker compose logs -f
docker compose down
```

The published port is bound to your computer only. Docker maps host port `8082` to the container's private port `8000`; another app can use host port `8080` independently. Change the left-hand `8082` in `compose.yaml` if it is occupied, then run `docker compose up -d` to apply the mapping. Rebuild after source changes with the original start command. Backend health is available at <http://localhost:8082/api/health>.

Files are parsed by the **local Python service**, not sent to an external service. Parsed studies and results are held in memory for one hour and disappear on restart. Export before reloading: the browser does not restore old sessions. At most one calculation runs at a time; every solver stage has a 30-second limit and must finish optimally. A failure identifies the date/market and never returns partial totals as complete results.

## Inputs and workflow

1. Set usable energy capacity, grid-side power, round-trip efficiency and wear cost. Set the optional daily cycle limit only if required by the project.
2. Upload any market combination. Download the three working templates from the app or use `public/examples/daa.csv`, `ida.csv` and `idc.csv` together. These contain the original notebook's example prices, assigned an illustrative delivery date; they are not observed historical market data.
3. Choose the study timezone (default `Europe/Prague`) and, if needed, the day-ahead delivery product override.
4. Validate and inspect the shared-day coverage and validation report. Filter issues by file, CSV line, date or problem, expand exact missing delivery starts, or download all issues as CSV. Run optimization on the remaining common complete days.
5. Filter the results by year and/or month; all four revenue cards, the revenue overview and exports use those dates. Group revenue by day, Monday-start week, month or year. Revenue bars stack the DAA, IDA and ID (continuous/ID1) market contributions, using their existing colors; negative contributions stack below zero. The linked revenue/cycle tooltip shows each market and the gross/wear-adjusted totals. Exact totals remain in the expandable table. Missing/excluded dates are not replaced by zero or extrapolated.
6. In delivery detail, independently choose Day, Week, Month or Year and the corresponding period. Day retains exact quarter-hour MW dispatch and all 97 SOC boundaries. Week shows hourly summaries; Month and Year show daily summaries. Wider views show mean prices, summed grid energy in MWh and observed SOC minimum/maximum ranges, with gaps for missing dates. These are display aggregations only; the underlying optimizer is unchanged.
7. Use Export for the selected grouping's revenue summary, daily results, quarter-hour results or metadata. Exports respect the year/month filters and the shared overview period selection; the detail-period selector is a local chart drill-down. An omitted market remains "Not supplied"; an empty selected period displays an explicit no-data state.

The fourth delivery chart shows trading revenue/purchase costs, synchronized with prices, dispatch and SOC. It colors cash flows by DAA/IDA/ID, with solid bars for new positions and hatched bars for financial position closures. Receipts stack above zero and payments below; a dashed line shows net trading cash flow before wear. Hover shows buys/sells, MWh, receipts/payments and the separate wear allowance. New positions can subsequently be closed and do not necessarily represent final physical dispatch. Wider views sum cash flows at the actual quarter-hour prices, preserving separate receipts/payments even at negative prices. Missing dates remain gaps.

Every file uses UTF-8 (optional BOM), comma separators and decimal points:

```csv
datetime,price
2025-01-01T00:00:00+01:00,50.25
```

`datetime` is the delivery interval's **start**, not when a trade occurred. `price` is EUR/MWh. Negative and zero prices are valid. Header names are trimmed/case-insensitive; extra named columns are allowed. Offset-aware timestamps are converted to the selected timezone. Naive timestamps use the selected timezone, never the computer's implicit timezone.

Validation collects all recoverable issues across every uploaded file. Blank/missing, invalid or non-finite prices, duplicate delivery instants, off-grid times, extra row values and inconsistent hourly-product prices exclude their affected **day**, consistently with absent delivery rows. They do not block unrelated complete days. Each issue records the market, filename, physical CSV line (including the header), delivery date when known, supplied datetime/price, explanation and action. Multiline records include their start/end lines; duplicates identify the first occurrence. Missing intervals list exact expected delivery starts; gaps with no rows identify the missing date and market. Price rows with a valid datetime but invalid price still preserve the date, including at coverage boundaries.

Rows without a usable datetime are reported and skipped; their dates are never guessed. Remaining dates must still pass complete-grid validation. A wholly unreadable market file (encoding, headers, ambiguous CSV quoting or no readable dates) blocks the run and is reported alongside issues in the other files. Correct or remove that file explicitly; the tool never silently drops an uploaded market or resumes parsing after unsafe CSV record boundaries. Completely blank records are ignored. Upload size and request-configuration limits remain request errors. A combined date span above 50 years is reported as blocking rather than generating an unbounded calendar.

- **DAA:** 24 hourly prices or 96 quarter-hour prices per standard day. Auto mode uses each day's source cadence, allowing mixed historical products. Hourly prices expand to four quarters and retain hourly trade blocks. Use the explicit hourly override when a provider exports hourly prices as four repeated quarters; all four prices must match. Quarter-hour source rows in auto mode represent quarter-hour products even when some prices happen to match.
- **IDA and IDC:** 96 quarter-hour delivery prices per standard day. Hourly intraday prices are not expanded or fabricated. IDC expects an index such as ID1 for each delivery quarter, not a transaction/order-book file.
- **Coverage:** only complete, valid dates shared by all uploaded markets are modelled. Clock-change days (23/25 hours) are explicitly excluded in the selected study timezone to preserve the original fixed-96 indexing. Other incomplete/missing days have separate reasons. Nothing is interpolated or silently filled. A study without common complete days can be inspected but cannot run. The full validation report is retained in result coverage and the metadata export. Missing dates outside the files' observed endpoints cannot be inferred; excluded dates are not zero-revenue days or inputs to cycle averages.

## Model fidelity and adaptations

The root `optimizer.py`, notebook, mathematical formulation and GPL licence come from [FlexPwr/bess-optimizer](https://github.com/FlexPwr/bess-optimizer). The Python source is **unchanged**. `backend/provenance.json` records the reviewed source SHA-256; the service refuses calculations if it changes unexpectedly. The frontend's previous independent JavaScript solver has been removed.

`backend/engine.py` subclasses the upstream class and wraps its GLPK solve boundary. Every enabled stage still calls its original Python method, objective and financial closing/new-position logic. Existing positions pass forward at full precision. Later prices never enter earlier stages. Days start/end empty and have no energy carry between days.

The adapter makes only these documented mathematical changes:

- For 15-minute day-ahead products, deactivate the six hourly-block equality components.
- Below 100% efficiency, apply `eta = sqrt(roundtripEfficiency)` to **combined physical** charging/discharging after position closures. SOC evolves by `0.25 * (eta * chargeMW - dischargeMW / eta)`.
- At every efficiency, including 100%, enforce a binary physical direction: combined physical charging and discharging cannot overlap. If `maxCyclesPerDay` is supplied, internal charged/discharged energy must each stay below `capacityMWh * maxCyclesPerDay`; otherwise the inherited throughput constraints are deactivated. At 100%, the upstream lossless SOC equations remain.
- Each stage subtracts the change in expected physical wear from its gross cash-flow objective. Wear uses internal discharged energy; the final allowance is counted once.
- Prevent offsetting buys and sells within a single market stage and delivery quarter. Opposite trades across different stages can still legitimately close earlier positions. Reversing a full charging position into full discharge can require financial sales of `2 * maxPowerMW`, while physical discharge stays within `maxPowerMW`.

Inherited market-position power constraints are intentionally retained. All results now use an **adapted model**, including lossless hourly runs, because physical/trading safeguards take precedence over reproducing degenerate upstream flows. The untouched upstream source remains available for reference comparisons. The original notebook's lossless example objectives still match in the regression test; identical schedules or downstream totals are not promised for arbitrary inputs.

Each stage maximizes its own incremental revenue using the positions it receives. Equally optimal schedules can leave different positions for the next stage, changing later revenue without changing the earlier stage's objective. There is no joint three-market optimization or tie-breaking based on future markets. The daily empty-SOC boundary also excludes overnight arbitrage. See [the algorithm audit](docs/algorithm-audit.md) for confirmed fixes and remaining modelling limits.

The wrapper checks optimal status before loading a solution, validates every active constraint and variable bound, independently rejects simultaneous physical flow or same-stage trade churn, reconciles SOC/power/throughput/closing trades and cash flows, and captures all **97 SOC boundaries**. Normalized power tolerances do not grow with energy capacity. Published dispatch contains the validated physical legs rather than a net that could conceal simultaneous flows. Financial closing trades are included in stage revenue but do not independently incur battery losses or count as cycles. Final physical cycles are internal discharged energy divided by capacity.

## Development and tests

Use Python **3.11** and GLPK (`glpsol` on PATH, or set `GLPSOL_PATH` to its full executable path). On Debian/Ubuntu, install GLPK with `apt-get install glpk-utils`. The Docker runtime uses GLPK 5.0. The scientific dependencies remain NumPy 1.24.3 and Pyomo 6.6.2, matching upstream.

```powershell
python -m venv .venv
.\.venv\Scripts\python -m pip install -r backend\requirements-test.txt
.\.venv\Scripts\python -m uvicorn backend.app:app --host 127.0.0.1 --port 8000
```

In another terminal, with Node 22 or later:

```powershell
npm.cmd ci
npm.cmd run dev
```

Vite proxies `/api` to port 8000. `npm.cmd run build` builds production assets; `npm.cmd run lint` checks TypeScript/React source. Restart the Python service after rebuilding if it was started before `dist` existed. Production uses one Uvicorn process because state and the calculation worker are in memory.

`npm.cmd run test:views` runs the result-view calculation tests using Node's built-in runner. They cover filtered revenue reconciliation, all aggregation periods, cross-year weeks, leap years/timezone independence, missing-vs-zero observations, MW-to-MWh conversion and SOC ranges.

```powershell
.\.venv\Scripts\python -m pytest tests -q
.\.venv\Scripts\python scripts\annual_smoke.py --url http://127.0.0.1:8000
```

The annual smoke script requires the running service and defaults to Docker at `http://localhost:8082`; use `--url http://127.0.0.1:8000` for the direct development backend. It uses deterministic **synthetic** 2025 market prices to exercise all three stages over 363 standard days, excluding the two clock-change days. It reconstructs physical positions after every stage for all 34,848 quarter-hour rows, checks direction, power, energy, closures, cycles and cash flows, and writes a compact ignored report under `.tools`. This is an integration/performance test, not a historical revenue estimate. The unit/API suite covers upstream notebook parity, all seven combinations, hand-calculated arbitrage, negative prices, efficiency, cycle limits, financial closures, adversarial forced-overlap/reversal tests, timestamp/CSV errors, coverage, expiry and solver failures. Solver tests require GLPK and do not silently skip it.

See [the implementation validation record](docs/validation.md) for measured results and Docker verification details.

## API

- `POST /api/studies`: multipart optional `daa`, `ida`, `idc` files, `timezone`, `dayAheadProduct` (`auto`, `60`, `15`); returns study ID and coverage preview, including `issues`, `issueCount`, `blockingFiles` and per-file parsing summaries. File/data problems return an inspectable preview even when no run is possible; request/configuration errors return HTTP 422.
- `POST /api/runs`: JSON `{ "studyId": "...", "battery": { "capacityMWh": 4, "maxPowerMW": 1, "roundtripEfficiency": 0.85, "wearCostPerMWh": 20, "maxCyclesPerDay": null } }`; returns a run ID with HTTP 202.
- `GET /api/runs/{id}`: queued/running/completed/failed status, day/market progress; result is present only on completion.
- `GET /api/health`: readiness, source fingerprint and GLPK version; unavailable solver returns HTTP 503.

Each upload is limited to 32 MiB. Run metadata includes input file hashes, battery inputs, timezone/products, excluded dates, source/wrapper versions, solver and modelling assumptions. API docs are available at `/docs`.
