# Wear-aware objective update - wrapper 1.2.0, 26 October 2026

This update supersedes the mandatory daily throughput cap and gross-only objective described in the retained 1.1.0 audit below. The physical, market-position, timestamp, chronology and source-integrity safeguards remain.

- Default wear rate: EUR 20 per internal discharged MWh, an illustrative screening assumption. Default daily cycle cap: none; an optional contractual cap remains supported.
- Each stage maximizes `incremental gross cash flow - (wear_after - wear_before)`. Physical wear uses the combined schedule after closing prior positions. Keeping the incoming schedule is feasible with zero incremental gain. A negative incremental cash flow can be rational if it saves more physical wear.
- Stage wear changes telescope to the wear of the final schedule. No wear is charged to offsetting financial trades or repeatedly to intermediate planned schedules. Independent checks reconcile objective values, cash flows, wear changes, final discharged energy and equivalent full cycles.
- Final wear-adjusted margin is gross trading margin minus the final physical wear allowance. It remains an economic measure before other costs, not project cash flow. Do not double count the allowance and actual replacement/augmentation expenditure in a financial model.
- Grouped and filtered cycle averages divide by the number of modelled days, including genuine zero-cycle days. Missing/DST days are excluded rather than treated as zeros. Average totals per represented week/month/year include partial periods without extrapolation.
- Upstream reference tests explicitly use zero wear and the previous 1.5-cycle cap where appropriate. New tests exercise all three stages with wear, internal-energy loss accounting, unconstrained cycling versus optional caps, negative cash-flow closures that save wear, and multi-stage accounting without double counting.

# Algorithm audit — wrapper 1.1.0, 21 October 2026

## Scope and conclusion

The app is a sequential, perfect-foresight historical revenue benchmark for a standalone battery across day-ahead, intraday auction and intraday continuous prices. It is not a forecasting model or an executable trading simulation. This audit examined the actual upstream Pyomo construction, wrapper modifications, position handoff, independent reconciliation and output accounting, and used adversarial solver cases to distinguish allowed financial trades from impossible physical operation.

Two modelling loopholes were reproduced and closed. Independent numerical checks were also tightened. The original `optimizer.py` remains unchanged, SHA-256 `202acdb027e4812e79ab4c7475f6d8404736ef333fc9baea16f037d3c0cd91fd`. The wrapper now always adds physical/trading safeguards, including at 100% efficiency; exact mathematical identity with the original lossless model is no longer claimed.

## Confirmed issues and fixes

| Finding | Evidence before the fix | Implemented safeguard |
|---|---|---|
| Simultaneous physical charge/discharge at 100% efficiency | Fixing both physical legs to positive equal power left the old lossless formulation feasible, with unchanged SOC. The old reporting netted these legs, concealing the overlap. This proves possibility, not occurrence in every optimized dataset. | A binary direction applies in every stage at every efficiency. An independent validator also rejects overlapping physical legs. Reports publish those validated legs. |
| Cancelling and reopening a position within the same stage | With an existing charging position, an IDA/IDC stage could sell to close and buy the same amount at the same quarter's clearing price. At zero prices the solver accepted pointless turnover without changing physical dispatch or revenue. | Each market stage/quarter permits financial trades in only one direction, counting new and closing trades together. Opposite trades across different stages remain permitted. |
| Numerical power checks depended on energy capacity | The old generic tolerance grew with MWh capacity and was also used against normalized power. This weakened defensive validation for extremely large batteries. | Dimensionless position/power checks use their own fixed tolerance; SOC and throughput use energy tolerances. A regression test rejects normalized power 1.0001 even with capacity 1 billion MWh. |

The adversarial tests first require an infeasible result with the new guards, then deactivate the relevant guards and require feasibility. This demonstrates that the guard, rather than an unrelated energy constraint, blocks the constructed loophole. Separate tests prove that independent validation rejects overlapping flows even if the model's direction constraints are disabled.

## Physical and financial accounting

For quarter `q`, after a later market's trades:

```text
C = previous charge - sell to close + new buy
D = previous discharge - buy to close + new sell
0 <= C <= P, 0 <= D <= P, and at most one is positive
eta = sqrt(round-trip efficiency)
SOC_next = SOC_previous + 0.25 * (eta * C - D / eta)
0 <= SOC <= usable capacity
```

Both internal charged energy and internal discharged energy are limited by capacity times the daily cycle limit. Because the battery starts and ends empty, these internal totals agree within numerical tolerance. A daily sum of grid charging above capacity is possible: losses and recharging after an earlier discharge do not imply an SOC violation. Capacity limits energy stored at an instant, not total energy bought during a day.

Closing a financial position does not separately consume energy or cycles. For example, buying 1 MW in DA and selling 1 MW to close in IDC can leave zero physical dispatch for that quarter; the cash-flow difference is legitimate market arbitrage in this benchmark. A full reversal from charging at `P` to discharging at `P` requires selling `P` to close and selling another `P` as a new position. This is `2P` of financial sales with physical discharge of only `P`; the new guards explicitly preserve that feasible case.

Stage cash flow is `0.25 * price * (new sell + sell to close - new buy - buy to close)`. Final physical dispatch is never repriced at one market's price. Intermediate stage schedules are alternative planned schedules before delivery, so their physical cycles must not be added together as if all plans were executed.

Negative prices are not automatically a bug. With round-trip losses, buying and later selling at the same negative price can earn revenue because less energy is sold back than was bought. The intervals must be different; instantaneous dissipation through simultaneous charging/discharging is blocked. The existing hand-calculated regression covers this case. Without degradation costs, such revenue may overstate commercial attractiveness.

## Remaining material limitations

| Limitation | Consequence | Treatment in this version |
|---|---|---|
| All supplied prices in a stage are known in advance | Results omit forecast error and can overstate achievable trading revenue. IDC/ID1 averages are especially different from guaranteed executable prices. | Labelled historical revenue potential. No forecasting or order simulation is claimed. |
| No bid/ask spread, fees, slippage, liquidity, market depth or fill risk | Every chosen trade is assumed available at the single supplied delivery price, even for closing/reversal volumes. Financial profits may survive with no final battery cycling. | Explicit assumption, consistent with the agreed revenue-only scope. A trading backtest would need timed executable quotes/trades, volumes, gate closures and execution rules. |
| Each stage uses a full daily price vector and may revise the whole day's positions | The model abstracts away the real chronology of continuous trading, product gate closures and auction sessions; it does not freeze intervals that have already delivered. | Retains the original three-stage benchmark. It is not a rolling operational controller. |
| Empty SOC at both ends of every day | Overnight energy transfer is prohibited, so valuable cross-midnight opportunities can be missed. Flat EUR 10 prices on day one and EUR 100 on day two yield zero in this model despite a possible overnight opportunity. | Explicit fixed boundary; regression verifies it. Changing it requires a multi-day/rolling formulation rather than removing a constraint in isolation. |
| Sequential objectives rather than a joint three-market objective | A DA schedule is chosen before IDA prices are used. Equally profitable earlier schedules can change later opportunities. The final total is not guaranteed to be the global three-market maximum or unique across alternative optimal schedules. | Intentional original-model behaviour. No future-stage prices are used to break earlier-stage ties. |
| Constant usable capacity, efficiency and symmetric power | No SOC-dependent efficiency/power, auxiliary consumption, ramp/settling constraints, degradation or capacity fade. A cycle limit is a coarse throughput budget. | Inputs are simplified effective battery parameters. These refinements need additional engineering data and model changes. |
| One representative price per delivery interval and market | Raw IDC transactions cannot be treated as quarter-hour clearing prices. Distinct intraday auction sessions are not separately represented. | Three simple price files. User supplies the appropriate comparable series. |
| Same bidding zone and EUR/MWh assumed | Timezone conversion does not establish that files come from the same market area, currency or price definition. Incompatible series can produce misleading cross-market profit. | Explicit input instruction; the two-column format cannot infer or verify market identity. |
| Fixed 96-quarter day and incomplete-day exclusion | DST transitions and any day incomplete in an active market do not contribute to totals. This is not necessarily a whole calendar-year result. | Exclusions visible in coverage, metadata and exports; no interpolation or annualization. |
| Quarter-hour physical resolution; inherited position bounds | Sub-quarter behaviour is not modelled. Original market-position power and closing bounds remain an abstraction and are not a liquidity model. | Retained and independently checked; no inference of exchange-order executability. |

These are modelling boundaries, not additional confirmed capacity or energy-balance failures. Making trading returns realistic would require a different data layer and chronology, not just more price columns. For consulting, the current output should be presented as an idealized revenue benchmark with its actual coverage and assumptions.

## Reference fidelity and sensitivity

The original lossless hourly SOC/throughput equations, market bounds, closing bounds and objectives remain intact; new safety constraints are added. At 100% efficiency, regression tests compare original and hardened stage objectives for identical incoming positions, and run the original notebook's three-stage example at its 2 MWh / 1 MW settings. Schedules need not match when multiple optima exist.

For the notebook price files at the app's **default 4 MWh / 1 MW / 85% / 1.5 cycles** settings, the Windows GLPK comparison was:

| Incremental revenue, EUR | Wrapper 1.0.0 | Wrapper 1.1.0 |
|---|---:|---:|
| DA | 54.0845088168 | 54.0845088168 |
| IDA | 47.2943225122 | 47.2943225122 |
| IDC | 50.0375902392 | 51.6645686728 |
| Total | 151.4164215682 | 153.0434000018 |

DA trades were identical; IDA trades differed in three intervals while its optimal revenue stayed equal. IDC then received different incoming positions. This is a concrete illustration of sequential tie sensitivity, rather than evidence that extra revenue was recovered from removing an energy restriction. These illustrative prices are not historical observations, and the comparison is not an investment forecast. The ignored `.tools/audit-reference-1.0.0.json` and `.tools/audit-reference-1.1.0.json` retain this local comparison.

## Validation and location of changes

The physical/trading changes and independent checker are in `backend/engine.py`; source/version information is in `backend/provenance.json`. `tests/test_realism.py` adds forced overlap, same-stage churn, full reversal, future-energy borrowing, random price reconciliation, independent-checker bypass, tolerance scaling, identical-incoming-position fidelity and daily-boundary cases. Existing tests cover all seven upload combinations, hourly/quarter-hour products, cycles including zero, losses, closures, CSV/timezone/DST validation and solver failures.

`scripts/annual_smoke.py --url http://localhost:8082` checks the Docker API over synthetic 2025 inputs. It reconstructs each stage's physical positions from exported financial trades and independently checks direction, power, closure bounds, energy balances, all 97 SOC boundaries, throughput, daily cycles and cash flows. See [the validation record](validation.md) for actual completed test and deployment measurements.
