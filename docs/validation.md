# Implementation validation — 21 October 2026

Current Docker address: **http://localhost:8082**. The host port was changed on 22 October 2026; references to port 8080 below describe earlier validation runs.

## Port change — 22 October 2026

- Docker Compose now publishes `127.0.0.1:8082` to the container's private port 8000. The existing service was recreated successfully, releasing host port 8080.
- The frontend returned HTTP 200 at the new address. `/api/health` confirmed solver readiness, GLPK 5.0.0.0 and the unchanged upstream source fingerprint.
- Uploaded the three bundled example CSVs through the new address, validated their common day, and completed the three-market calculation successfully.
- Updated the README, algorithm-audit smoke command and annual smoke script default URL. The original image was reused because this change only affects the host port mapping.

Validated on Windows using Python 3.11.13, NumPy 1.24.3, Pyomo 6.6.2 and GLPK 5.0.0.0.

The first sections record wrapper **1.0.0**. The **1.1.0 algorithm audit** section below supersedes its old lossless exception and example totals. Historical measurements are retained with their original scope.

## Automated checks

- **68 backend tests passed**: original notebook reference parity; unchanged active constraints/objective in lossless hourly mode; all seven market combinations at 100% and 85% efficiency; hand-calculated arbitrage; quarter-hour DA; negative/zero prices; internal cycle budgets; financial closures without physical cycling; absence of future-market prices in earlier stages; input/calendar validation; API lifecycle, concurrency and solver failure handling.
- TypeScript project check, ESLint and Vite production build passed.
- Source SHA-256 remained `202acdb027e4812e79ab4c7475f6d8404736ef333fc9baea16f037d3c0cd91fd`.
- Package manifest and npm lockfile dependency declarations agree.

## Annual HTTP integration test

The real local HTTP service processed three deterministic **synthetic** 2025 files using the default battery settings. These prices test the implementation; they do not estimate actual historical market revenues.

| Check | Result |
|---|---:|
| Complete modelled days | 363 |
| Explicitly excluded clock-change days | 2 |
| Quarter-hour output rows | 34,848 |
| Optimization stages finishing optimally | 1,089 |
| Elapsed time on this machine | 151.53 seconds |

The excluded dates were 30 March and 26 October 2025 in Europe/Prague. Stage, daily and interval cash flows reconciled. Every stage contained all 97 SOC boundaries. The generated report is `.tools/annual-smoke.json`; rerun with `python scripts/annual_smoke.py` while the service is running. Performance varies by machine and input prices.

## Browser verification

The production interface was exercised with all three files, DAA + IDC (skipping IDA), and IDC alone. Missing markets displayed **Not supplied**. Battery controls froze during calculation. Changing capacity removed the old results and required a fresh preview. Removing a market invalidated the prior result. Day-level charts rendered 96 intervals and 97 SOC boundaries.

For the upstream notebook examples at the app's default 4 MWh / 1 MW / 85% / 1.5 cycles settings:

| Incremental stage | Revenue, EUR |
|---|---:|
| Day-ahead | 54.0845088168 |
| Intraday auction | 47.2943225122 |
| Intraday continuous | 50.0375902392 |
| Total | 151.4164215682 |

Both CSVs were downloaded through the actual browser controls. The 96 exported interval cash flows, three market cash-flow columns and daily summary reconciled to the same total; terminal SOC was zero.

## Docker verification follow-up

Docker Desktop was subsequently found in the nonstandard per-user `Programs/DockerDesktop` installation directory; its CLI was absent from PATH. The Compose project was confirmed to use this project folder. Its previous container still held the old Nginx image and required rebuilding rather than simply refreshing the browser.

The updated image was successfully built and the existing container recreated using `docker compose up --build -d`. The app is served at `http://localhost:8080`, mapped to container port 8000. The container's readiness endpoint confirmed GLPK 5.0 and the unchanged upstream fingerprint. A complete three-market example was uploaded and calculated through the Docker API: all 96 intervals completed and total revenue reconciled to EUR 151.4164215682, matching the directly tested service. The Docker-hosted browser interface was also checked for all three upload slots. The annual benchmark above was run directly on Windows, rather than inside Docker.

## 1.1.0 algorithm audit

The wrapper now enforces physical direction at every efficiency, including 100%, prohibits offsetting buys/sells within an individual stage/quarter, publishes validated physical legs without hiding gross overlap through netting, and uses dimensionless tolerances independent of energy capacity. Cross-market closing trades and a full financial reversal of up to twice physical power remain permitted. The original source fingerprint is unchanged. See [the full algorithm audit](algorithm-audit.md) for evidence and material limitations.

- **92 backend tests passed in 24.66 seconds**, including 24 new realism/fidelity tests. The only warning was a Starlette test-client deprecation for an AnyIO alias.
- ESLint passed. The Docker build passed TypeScript and Vite production compilation.
- Identical-incoming-position stage comparisons at 100% efficiency match upstream objectives. The original notebook's 2 MWh / 1 MW / 100% three-stage reference also passes. Tests assert original equations and objective stay unchanged while safety constraints are added.
- Adversarial cases reject forced simultaneous physical operation across all stages at both 85% and 100% efficiency and same-stage cancel/reopen churn in IDA/IDC. Removing the corresponding guards makes those cases feasible. A separate independent-validator test detects physical overlap even when model guards are disabled.
- Full 2P financial reversals, no borrowing of future energy, randomized negative/positive prices, the daily empty boundary and capacity-independent power validation pass.
- The existing Docker Compose app was rebuilt/recreated at `http://localhost:8080`. The build context excludes an unrelated nested checkout; its inaccessible cache initially prevented the build. Docker readiness confirms GLPK 5.0.0.0 and the reviewed source fingerprint.
- The Docker API's default three-file example returned DA EUR 54.0845088168, IDA EUR 47.2943225122 and IDC EUR 51.6645686728, total **EUR 153.0434000018**, matching the Windows result. At 100% efficiency and otherwise default settings the total was **EUR 195.50**. Every raw trade was reconstructed into intermediate/final physical flows and reconciled in both runs. The 85% result differs from 1.0.0 because equally optimal IDA positions changed before the IDC solve, as explained in the audit.

### Full-year Docker reconciliation

The strengthened annual HTTP test completed successfully against **the rebuilt Docker container** at `http://localhost:8080`, wrapper 1.1.0, default battery settings. Deterministic synthetic 2025 inputs produced:

| Check | Result |
|---|---:|
| Modelled days | 363 |
| Explicitly excluded DST dates | 30 March / 26 October |
| Quarter-hour rows | 34,848 |
| Optimal stage solves | 1,089 |
| Elapsed time, including validation and response checks | 99.99 seconds |
| Response size | 17,305,470 bytes |
| Synthetic test cash-flow total | EUR 88,369.1294608753 |

Every quarter was independently reconstructed from the exported new/closing trades after **each** stage. Checks passed for physical direction, same-stage financial direction, grid power, closing bounds, SOC energy balances/bounds, 97 boundaries, terminal/initial SOC, internal throughput and final cycles. Interval, stage, daily and total cash flows reconciled. The compact report is `.tools/annual-smoke.json`; its result is a test fixture, not a historical revenue estimate. This Linux-container timing and the earlier direct-Windows timing are different runtime environments and should not be interpreted as a controlled performance comparison.

### Updated browser verification

The Docker interface was reloaded, all three notebook example files were selected, efficiency was set to **100%**, coverage was validated and optimization completed through the actual UI. The displayed total was EUR 195.50 (DA 94.00, IDA 46.00, IDC 55.50). The expanded assumptions panel visibly confirms wrapper 1.1.0, all stages optimal, physical direction at every efficiency and the remaining modelling assumptions. A local proof screenshot is saved at `.tools/algorithm-audit-preview.jpg`.

## Result period controls — 22 October 2026

The frontend now supports year/month filters shared by the revenue cards, overview, scoped exports and available delivery detail. Revenue can be grouped by day, Monday-start week, month or year, with exact values in an expandable table. Delivery detail has independent Day/Week/Month/Year controls: Day retains the delivery-date picker and 96 power intervals/97 SOC boundaries; Week uses hourly summaries and Month/Year daily summaries. Aggregated physical activity is labelled energy in MWh, prices are time-interval averages and SOC shows observed minimum–maximum ranges. Missing dates remain gaps; excluded-only revenue buckets remain null rather than zero. No optimizer, backend constraints, cycle settings or source fingerprint changed.

- **10 frontend calculation/export tests passed**, run with `node --test scripts/result-views.test.mjs` / `npm run test:views`. Tests reconcile filtered and grouped cash flows, omitted markets, cross-year weeks, leap years/computer-timezone independence, no-data selections, conversion from MW to MWh, SOC ranges, and exact daily/quarter-hour export membership.
- TypeScript and ESLint passed. The real Docker production build completed and the existing app was recreated at `http://localhost:8080`. The host's direct Vite attempt encountered a sandbox file-access restriction; the Docker TypeScript/Vite build succeeded.
- Browser verification used **synthetic test prices**, spanning twelve complete dates across December 2024, January/February 2025 and January 2026. A separate hand calculation established the expected three-market cash flows. All-date cards showed EUR 12,009.70; January 2025 showed EUR 5,008.92; January across all years EUR 7,004.03; and all 2025 EUR 8,006.47. These are test outputs, not historical market estimates.
- The browser's downloaded monthly summary CSV for January 2025 contained exactly one bucket, five modelled days, 26 excluded days and EUR 5,008.92427103277. All three market cash flows reconciled independently. Row-level export calculations were separately tested against the selected population; a second browser download did not complete during automation and was not counted as a verified download.
- Day/Week/Month/Year detail controls, revenue grouping, exact totals, selecting All years while retaining January, empty April 2025, resetting to all dates and the cross-year week were exercised. Desktop (1280 × 900) and normal narrow preview layouts were inspected; temporary viewport sizing was reset. No browser error logs were present. The desktop proof is `.tools/period-controls-desktop.jpg`.

## Wear-aware optimization and cycle reporting - 26 October 2026

Wrapper 1.2.0 is built and running at **http://localhost:8082**. The default economic input is EUR 20/internal discharged MWh with no daily cycle cap; the optional contractual cap remains available. The upstream optimizer SHA-256 is unchanged.

- **122 backend tests passed in 46.95 seconds**, with the existing Starlette/AnyIO deprecation warning. New cases verify all seven market combinations at 100% and 85% efficiency with wear, low-spread rejection, internal discharged-energy units, physically bounded 12-cycle lossless operation without an arbitrary cap, optional 1.5/zero caps, telescoping physical wear across closures, cash-negative closures that improve wear-adjusted margin, input validation and averages including zero-cycle modelled days.
- **12 frontend calculation/export tests passed**. Tests reconcile wear, gross and wear-adjusted margins, total cycles and weighted daily averages through filters and every grouping. Missing periods retain null averages; exports preserve excluded-day nulls.
- TypeScript and ESLint passed locally. The production Docker build completed, the existing service was recreated, and the full integration script reconciled every interval and stage over **363 synthetic modelled days / 34,848 quarters**, excluding the two DST dates. Elapsed time: 81.16 seconds. Synthetic gross margin: EUR 88,031.355625689; wear allowance: EUR 29,040; wear-adjusted margin: EUR 58,991.355625689; cycles: 363; average: 1/modelled day. These are synthetic integration-test outputs, not historical or forecast revenues.
- Browser validation used the existing synthetic twelve-date fixtures across 2024-2026. All-date gross margin was EUR 12,009.70, wear EUR 960 and adjusted margin EUR 11,049.70, with 12 cycles and 1/modelled day. Monthly grouping averaged 3 cycles across four represented partial months. January 2025 showed 5 cycles, 1/modelled day, wear EUR 400 and adjusted margin EUR 4,608.92. Year 2025 showed 8 cycles, wear EUR 640 and adjusted margin EUR 7,366.47. Excluded-only April showed dashes for totals and averages rather than zero-cycle observations.
- The monthly summary CSV downloaded through the actual browser control reconciled to the displayed January values and included total cycles, average cycles/modelled day, internal discharged MWh, wear cost and adjusted margin. Daily and quarter-hour rows are separately covered by the export tests. The default narrow browser layout was visually inspected; the saved proof is `.tools/wear-cycle-preview.png`. The summary uses clearly documented partial-period averages without extrapolation.


## Overview navigation and linked chart tooltips - 26 October 2026

- Revenue chart now precedes the physical-cycle chart. One shared control bar distinguishes **Show period** (all filtered dates, one day/week/month/year, with a period picker) from **Group charts by** (daily/weekly/monthly/yearly). Existing year/month filters remain available. Choosing one day restricts calculations, summary cards, both charts and exports to that date. Excluded days can be explicitly selected and remain empty observations.
- Revenue and cycle tooltips synchronize by the actual period key in both directions. The lower price/dispatch/SOC charts also share a separate synchronization group. This prevents overview and delivery detail from activating each other accidentally.
- The cost caption now explicitly reads **Run wear rate** from result metadata; input guidance no longer includes a fixed EUR 20/MWh sentence.
- **15 frontend tests passed**, including new single-date, cross-year week, month/year focus, filter intersection, missing-date and scoped export regressions. TypeScript, ESLint, local production build and Docker image build passed. This change does not alter the backend optimization.
- The built frontend was copied into the existing running container without restarting the calculation service, preserving its in-memory studies. The Docker image was also rebuilt for future recreation.
- Browser verification used the synthetic twelve-date fixtures with a deliberately edited wear rate of **EUR 35/MWh**. The cost caption showed EUR 35, total wear EUR 1,680 and adjusted margin EUR 10,329.70. Selecting 2 January 2025 showed one daily bar, one physical cycle, EUR 140 wear and EUR 862.44 adjusted margin. Selecting missing 6 January showed no modelled days and null cycle averages.
- Hovering the January 2025 revenue bar activated visible revenue and cycle tooltips for the same month. Hovering the 3 January cycle bar activated both tooltips for 3 January, with matching gross/wear/adjusted/cycle values. The one-day summary downloaded through the actual export control contained only 2 January and reconciled to the displayed figures. Screenshot proof: `.tools/overview-controls-preview.png`.

## Recoverable file validation - 26 October 2026

Wrapper 1.3.0 adds structured validation diagnostics and consistent day exclusions. The optimizer and its upstream fingerprint are unchanged. A blank or invalid price, duplicate timestamp, malformed row with a known delivery date, or missing interval excludes that date from every uploaded market while preserving other complete dates. Unknown-date rows are explicitly reported and skipped; complete delivery grids remain mandatory. Unsafe whole-file failures are reported alongside issues in other files, and prevent running until the affected market file is corrected or explicitly removed.

- **149 backend tests passed** in 55.43 seconds, with the existing Starlette/AnyIO deprecation warning. The final importer refinement was followed by **55 passing input tests**. Regression cases cover omission/blank/text/non-finite equivalence, multiple errors across files, unknown dates, duplicate references, extra columns, off-grid delivery, local product-override errors, hourly missing intervals, all-invalid days, unreadable files, multiline CSV line ranges, DST and bounded calendar ranges. The API integration run reconciles the dirty upload's good days against an equivalent clean upload for revenue, wear, wear-adjusted margin, cycles and average cycles.
- **16 frontend calculation/export tests passed**. TypeScript and ESLint passed. Local and Docker production builds passed, retaining the existing bundle-size advisory.
- Browser verification ran in an isolated local preview on port 8083. Six synthetic dates contained a blank price, NaN, an absent interval, an invalid datetime and a duplicate timestamp. Validation reported **six issues, four excluded days and two runnable complete days**. Date filtering and expansion showed the exact missing delivery start. The actual downloaded validation CSV contained all six issues while the table was filtered to one issue.
- Optimization through the browser completed with two modelled days, two physical cycles, one cycle per modelled day, gross EUR 650.791373455969, wear EUR 160 and wear-adjusted margin EUR 490.791373455969. An independent smoke run in a disposable container using the final production image produced the same values and preserved all diagnostics. These are synthetic integration outputs, not historical revenue estimates.
- A synthetic 365-day quarter-hour file with 35 blank prices validated in 0.319 seconds, retaining 328 days and excluding 37 (35 affected days plus two clock-change dates). Screenshot proof: `.tools/validation-report-preview.png`.
- Following explicit user approval to clear the existing in-memory runs, the production app was recreated on port 8082 with wrapper 1.3.0. A live HTTP smoke check confirmed service readiness, the updated frontend bundle, all six reported issues, two runnable days and a completed optimization matching the isolated-container values above. The activation report is `.tools/recoverable-inputs/deployment-smoke.json`.

## Stacked market revenue and fourth delivery chart - 26 October 2026

- The revenue overview stacks DAA, IDA and ID (continuous/ID1) in the existing blue, teal and yellow market colors, in stage order. Negative contributions stack below zero. The linked revenue/cycle tooltip now includes each supplied market's contribution as well as gross margin, wear, adjusted margin and cycles. Omitted markets are excluded from the stack and legend.
- A fourth delivery chart below SOC shows purchase/sales cash flows in EUR, using the same delivery keys, selected period and synchronization group as prices, physical dispatch and SOC. Solid bars indicate new positions; hatched bars identify buy/sell position closures. New positions are deliberately not labelled physical, because later stages may close them. Receipts and payments are accumulated separately for each market and trade type, including at negative prices. A dashed line shows net trading cash flow before wear; the tooltip provides buys/sells, MWh, receipts/payments, net margin and the separate physical wear allowance.
- **19 frontend calculation/export tests passed**, including hand-calculated market closures with no physical wear, negative-price sign reversals, separate gross cash directions within an aggregated hour, omitted markets, quarter-hour MW-to-MWh conversion, cash-flow reconciliation at every resolution and missing-date gaps. TypeScript, ESLint, local Vite and Docker production builds passed; the existing bundle-size advisory remains. The backend and optimizer are unchanged.
- Browser verification used the illustrative notebook example inputs in a separate disposable container on port 8083 because a user calculation was running on port 8082. At 100% efficiency, zero wear and no cycle cap, the displayed synthetic reference totals were DAA EUR 104, IDA EUR 72.25 and ID EUR 46.50, summing to EUR 222.75 and visibly stacking in three colors. These are test outputs, not historical revenues. The fourth chart's monthly-view daily tooltip independently reconciled all purchase/sales/closing legs to EUR 222.75.
- Clicking a hatched closure bar at 08:45 showed DAA sales EUR 12, IDA new/closing purchases EUR 7.25 each and ID new/closing sales EUR 10 each, net EUR 17.50. Prices, dispatch, SOC and cash-flow hover all selected 08:45. Week, Month and Year controls rendered the corresponding hourly/daily cash-flow grids with missing-date gaps. Proof images: `.tools/stacked-revenue-preview.png` and `.tools/trading-cashflows-preview.png`.
- The finalized frontend was copied into the existing production container without a restart. Its start time remained `2026-10-26T12:15:06.754903598Z`, preserving the active calculation and stored backend studies/results. The Docker image was also rebuilt for future starts. The browser requires a refresh to load the new bundle and does not restore its local results view, so current results should be exported before refreshing.
