import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// Exercise the actual view-calculation module with Node's built-in test runner.
// Its only imports are types, so no browser or extra test dependency is needed.
const source = await readFile(new URL('../src/lib/resultViews.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const views = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const typeModule = ts.transpileModule(await readFile(new URL('../src/types/index.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const typeUrl = `data:text/javascript;base64,${Buffer.from(typeModule).toString('base64')}`;
const exportSource = await readFile(new URL('../src/lib/exports.ts', import.meta.url), 'utf8');
const exportModule = ts.transpileModule(exportSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  .replace("'../types'", JSON.stringify(typeUrl)).replace("'papaparse'", JSON.stringify(import.meta.resolve('papaparse')));
const exportRows = await import(`data:text/javascript;base64,${Buffer.from(exportModule).toString('base64')}`);

function day(date, cash) {
  let soc = 0;
  const schedule = Array.from({ length: 96 }, (_, q) => {
    const chargeMW = q < 4 ? 1 : 0, dischargeMW = q >= 4 && q < 8 ? 1 : 0;
    const start = soc; soc += .25 * (chargeMW-dischargeMW);
    const price = q < 4 ? [10, 20, 30, 40][q] : 100;
    return { datetime: `${date}T${String(Math.floor(q/4)).padStart(2, '0')}:${String((q%4)*15).padStart(2, '0')}:00+01:00`,
      chargeMW, dischargeMW, socStartMWh: start, socEndMWh: soc,
      trades: { daa: { price }, idc: { price: price+5 } }, revenue: cash*1.5/96,
      internalDischargedMWh: dischargeMW*.25, cycles: dischargeMW*.25,
      wearCost: dischargeMW*.25*20, wearAdjustedMargin: cash*1.5/96-dischargeMW*.25*20 };
  });
  return { date, marketRevenue: { daa: cash, ida: null, idc: cash/2 }, totalRevenue: cash*1.5,
    cycles: 1, averageCyclesPerDay: 1, internalDischargedMWh: 1, wearCost: 20,
    wearAdjustedMargin: cash*1.5-20, schedule };
}
const daily = [day('2024-12-30', 20), day('2025-01-01', 40), day('2025-01-05', -10), day('2025-02-01', 80), day('2026-01-01', 100)];
const excludedDates = [{ date: '2025-01-02', reasons: ['Missing IDC'] }, { date: '2025-03-30', reasons: ['Clock-change day'] }];
const result = { daily, marketRevenue: { daa: 230, ida: null, idc: 115 }, totalRevenue: 345, cycles: 5,
  internalDischargedMWh: 5, averageCyclesPerDay: 1, wearCost: 100, wearAdjustedMargin: 245,
  coverage: { includedDates: daily.map(d => d.date), excludedDates, markets: ['daa', 'idc'], modelledDays: 5, excludedDays: 2, canRun: true } };

function tradingDay(date, events) {
  const value = day(date, 0);
  const enabled = [...new Set(events.map(event => event.market))];
  value.marketRevenue = { daa: null, ida: null, idc: null };
  for (const market of enabled) value.marketRevenue[market] = 0;
  value.schedule.forEach((point, q) => {
    point.trades = Object.fromEntries(enabled.map(market => [market,
      { price: 0, buyMW: 0, sellMW: 0, buyToCloseMW: 0, sellToCloseMW: 0, revenue: 0 }]));
    for (const event of events.filter(event => event.q === q)) {
      Object.assign(point.trades[event.market], event);
    }
    point.revenue = 0;
    point.chargeMW = point.dischargeMW = 0;
    for (const [market, trade] of Object.entries(point.trades)) {
      trade.revenue = .25 * trade.price * (trade.sellMW + trade.sellToCloseMW - trade.buyMW - trade.buyToCloseMW);
      point.revenue += trade.revenue;
      value.marketRevenue[market] += trade.revenue;
      point.chargeMW += trade.buyMW - trade.sellToCloseMW;
      point.dischargeMW += trade.sellMW - trade.buyToCloseMW;
    }
    point.wearCost = Math.max(point.dischargeMW, 0) * .25 * 20;
  });
  value.totalRevenue = value.schedule.reduce((sum, point) => sum + point.revenue, 0);
  return value;
}

test('financial closures retain both market cash legs without inventing physical wear', () => {
  const source = tradingDay('2025-01-01', [
    { q: 0, market: 'daa', price: 50, buyMW: 4 },
    { q: 0, market: 'ida', price: 80, sellToCloseMW: 2 },
    { q: 0, market: 'idc', price: 100, sellToCloseMW: 2 },
    { q: 1, market: 'daa', price: 100, sellMW: 4 },
    { q: 1, market: 'ida', price: 60, buyToCloseMW: 4 },
  ]);
  const rows = views.tradeCashflowSeries([source], 'day');
  assert.equal(rows.length, 96);
  assert.equal(rows[0].cashByMarket.daa.buy.payments, -50);
  assert.equal(rows[0].cashByMarket.ida.sellToClose.receipts, 40);
  assert.equal(rows[0].cashByMarket.idc.sellToClose.receipts, 50);
  assert.equal(rows[1].cashByMarket.ida.buyToClose.payments, -60);
  assert.equal(rows[0].net, 40);
  assert.equal(rows[1].net, 40);
  assert.equal(rows.reduce((sum, row) => sum + row.net, 0), 80);
  assert.equal(rows.reduce((sum, row) => sum + row.wearCost, 0), 0);
  assert.equal(rows.reduce((sum, row) => sum + row.wearAdjustedMargin, 0), 80);
  assert.ok(source.schedule.every(point => point.chargeMW === 0 && point.dischargeMW === 0));
});

test('negative-price purchases and sales keep receipts and payments separate when aggregated', () => {
  const source = tradingDay('2025-01-01', [
    { q: 0, market: 'daa', price: 40, buyMW: 4 },
    { q: 1, market: 'daa', price: -20, buyMW: 4 },
    { q: 2, market: 'daa', price: -10, sellMW: 4 },
    { q: 3, market: 'daa', price: 100, sellMW: 4 },
  ]);
  const row = views.tradeCashflowSeries([source], 'week').find(row => row.key === '2025-01-01T00');
  assert.deepEqual(row.cashByMarket.daa.buy, { receipts: 20, payments: -40, energyMWh: 2 });
  assert.deepEqual(row.cashByMarket.daa.sell, { receipts: 100, payments: -10, energyMWh: 2 });
  assert.equal(row.net, 70);
  assert.equal(row.wearCost, 40);
  assert.equal(row.wearAdjustedMargin, 30);
  assert.equal(row.cashByMarket.ida, undefined);
});

test('cash flow sums reconcile to market cash flows at every detail resolution and preserve gaps', () => {
  const source = tradingDay('2025-01-01', [
    { q: 0, market: 'daa', price: 50, buyMW: 4 },
    { q: 4, market: 'daa', price: 100, sellMW: 4 },
    { q: 4, market: 'ida', price: 90, buyToCloseMW: 2 },
  ]);
  for (const grain of views.grains) {
    const rows = views.tradeCashflowSeries([source], grain);
    assert.equal(rows.reduce((sum, row) => sum + (row.net ?? 0), 0), source.totalRevenue);
    assert.equal(rows.reduce((sum, row) => sum + (row.wearCost ?? 0), 0), 10);
    assert.equal(rows.reduce((sum, row) => sum + (row.wearAdjustedMargin ?? 0), 0), source.totalRevenue - 10);
    for (const market of ['daa', 'ida']) {
      const cash = rows.reduce((sum, row) => sum + Object.values(row.cashByMarket[market] ?? {})
        .reduce((s, leg) => s + leg.receipts + leg.payments, 0), 0);
      assert.equal(cash, source.marketRevenue[market]);
    }
    assert.deepEqual(rows.map(row => row.key), views.detailSeries([source], grain).rows.map(row => row.key));
    if (grain !== 'day') {
      const missing = rows.find(row => row.net === null);
      assert.ok(missing);
      assert.equal(missing.wearCost, null);
      assert.deepEqual(missing.cashByMarket, {});
    }
  }
  assert.deepEqual(views.tradeCashflowSeries([], 'day'), []);
});

test('validation export preserves source locations, unknown dates and exact missing intervals', () => {
  const base = { market: 'ida', filename: 'prices.csv', row: null, endRow: null, relatedRow: null,
    date: '2025-01-01', datetime: null, price: null, scope: 'day', missingTimestamps: [] };
  const issues = [
    { ...base, row: 1438, endRow: 1438, datetime: '2025-01-01T12:00', price: '', code: 'price', message: 'Missing price' },
    { ...base, code: 'missing_intervals', message: 'Missing 2 intervals', missingTimestamps: ['2025-01-01T13:00', '2025-01-01T13:15'] },
    { ...base, scope: 'row', date: null, row: 2000, datetime: 'broken', code: 'datetime', message: 'Invalid datetime' },
    { ...base, scope: 'file', code: 'headers', message: 'Invalid headers' },
  ];
  const rows = exportRows.validationRows({ issues });
  assert.equal(rows.length, 4);
  assert.equal(rows[0].csv_line, 1438);
  assert.equal(rows[0].supplied_price, '');
  assert.equal(rows[1].missing_delivery_starts, '2025-01-01T13:00\n2025-01-01T13:15');
  assert.equal(rows[2].delivery_date, null);
  assert.match(rows[2].action, /date unknown/);
  assert.match(rows[3].action, /Correct or remove file/);
});

test('year/month filters reconcile independent source rows and preserve omitted markets', () => {
  const january = views.filterResult(result, { year: '2025', month: '01' });
  assert.deepEqual(january.daily.map(d => d.date), ['2025-01-01', '2025-01-05']);
  assert.deepEqual(january.marketRevenue, { daa: 30, ida: null, idc: 15 });
  assert.equal(january.totalRevenue, 45);
  assert.equal(january.cycles, 2);
  assert.equal(january.coverage.excludedDays, 1);
  assert.deepEqual(views.filterResult(result, views.allDates).daily, daily);
  assert.equal(result.totalRevenue, 345);
});

test('wear and cycles reconcile at every grouping and through filtered exports', () => {
  const selected = views.filterResult(result, { year: '2025', month: '01' });
  assert.equal(selected.wearCost, 40);
  assert.equal(selected.wearAdjustedMargin, 5);
  assert.equal(selected.internalDischargedMWh, 2);
  assert.equal(selected.averageCyclesPerDay, 1);
  for (const grain of views.grains) {
    const buckets = views.revenueBuckets(selected, grain);
    const rows = exportRows.revenueRows(buckets);
    assert.equal(rows.reduce((s, r) => s+(r.wear_cost_eur ?? 0), 0), 40);
    assert.equal(rows.reduce((s, r) => s+(r.wear_adjusted_margin_eur ?? 0), 0), 5);
    assert.equal(rows.reduce((s, r) => s+(r.physical_cycles ?? 0), 0), 2);
    assert.ok(buckets.filter(r => r.modelledDays).every(r => r.averageCyclesPerDay === r.cycles/r.modelledDays));
  }
  const intervals = exportRows.scheduleRows(selected);
  assert.equal(intervals.reduce((s, r) => s+r.physical_cycles, 0), 2);
  assert.equal(intervals.reduce((s, r) => s+r.wear_cost_eur, 0), 40);
  assert.ok(Math.abs(intervals.reduce((s, r) => s+r.wear_adjusted_margin_eur, 0)-5) < 1e-8);
});

test('cycle averages are weighted by modelled days including zeros, never missing dates', () => {
  const varied = { ...result, daily: [
    { ...day('2025-01-01', 10), cycles: 0 },
    { ...day('2025-01-02', 20), cycles: 2 },
    { ...day('2025-02-01', 30), cycles: 4 },
  ] };
  const selected = views.filterResult(varied, { year: '2025', month: 'all' });
  assert.equal(selected.cycles, 6);
  assert.equal(selected.averageCyclesPerDay, 2);
  const months = views.revenueBuckets(selected, 'month');
  assert.equal(months.find(r => r.key === '2025-01').averageCyclesPerDay, 1);
  assert.equal(months.find(r => r.key === '2025-02').averageCyclesPerDay, 4);
  assert.equal(months.find(r => r.key === '2025-03').averageCyclesPerDay, null);
  const empty = views.filterResult(varied, { year: '2025', month: '03' });
  assert.equal(empty.averageCyclesPerDay, null);
  assert.equal(empty.wearCost, 0);
  assert.equal(exportRows.dailyRows(empty)[0].average_cycles_per_modelled_day, null);
});

test('selecting a month across all years includes every matching year', () => {
  const january = views.filterResult(result, { year: 'all', month: '01' });
  assert.equal(january.totalRevenue, 195);
  assert.equal(january.daily.length, 3);
  assert.equal(views.filterLabel({ year: 'all', month: '01' }), 'January · all years');
  assert.deepEqual(views.availableYears(result.coverage), ['2024', '2025', '2026']);
});

test('focusing one day selects that date rather than a year of daily buckets', () => {
  const selected = views.focusResult(result, 'day', '2025-01-05');
  assert.deepEqual(selected.daily.map(d => d.date), ['2025-01-05']);
  assert.equal(selected.totalRevenue, -15);
  assert.equal(selected.cycles, 1);
  assert.equal(selected.wearAdjustedMargin, -35);
  assert.equal(views.revenueBuckets(selected, 'day').length, 1);
  assert.ok(exportRows.scheduleRows(selected).every(r => r.datetime.startsWith('2025-01-05')));
});

test('focus ranges cover the selected week/month/year and preserve existing filters', () => {
  const week = views.focusResult(result, 'week', '2025-01-01');
  assert.deepEqual(week.daily.map(d => d.date), ['2024-12-30', '2025-01-01', '2025-01-05']);
  assert.equal(week.cycles, 3);
  const month = views.focusResult(result, 'month', '2025-01-20');
  assert.equal(month.daily.length, 2);
  assert.equal(month.coverage.excludedDays, 1);
  const year = views.focusResult(result, 'year', '2025-08-01');
  assert.equal(year.daily.length, 3);
  assert.equal(year.totalRevenue, 165);
  const january = views.filterResult(result, { year: '2025', month: '01' });
  const clippedWeek = views.focusResult(january, 'week', '2025-01-01');
  assert.deepEqual(clippedWeek.daily.map(d => d.date), ['2025-01-01', '2025-01-05']);
});

test('period selectors include missing dates without replacing them with modelled days', () => {
  const options = views.overviewPeriods(result.coverage, 'day');
  assert.ok(options.some(p => p.key === '2025-01-02'));
  const missing = views.focusResult(result, 'day', '2025-01-02');
  assert.equal(missing.daily.length, 0);
  assert.equal(missing.coverage.excludedDays, 1);
  assert.equal(missing.averageCyclesPerDay, null);
  const buckets = views.revenueBuckets(missing, 'day');
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].cycles, null);
  assert.deepEqual(views.overviewPeriods(result.coverage, 'year').map(p => p.key), ['2024', '2025', '2026']);
});

test('each revenue grouping preserves cash flow; negative and missing values stay distinct', () => {
  for (const grain of views.grains) {
    const rows = views.revenueBuckets(result, grain);
    assert.equal(rows.reduce((sum, r) => sum+(r.totalRevenue ?? 0), 0), 345);
    assert.equal(rows.reduce((sum, r) => sum+r.modelledDays, 0), 5);
    assert.equal(rows.reduce((sum, r) => sum+r.excludedDays, 0), 2);
    assert.ok(rows.every(r => r.marketRevenue.ida === null));
  }
  const rows = views.revenueBuckets(result, 'month');
  assert.equal(rows.find(r => r.key === '2025-01').totalRevenue, 45);
  assert.equal(rows.find(r => r.key === '2025-03').totalRevenue, null);
  assert.equal(rows.find(r => r.key === '2025-03').modelledDays, 0);
});

test('weeks start on Monday and cross the calendar year without splitting or duplication', () => {
  assert.equal(views.periodKey('2025-01-01', 'week'), '2024-12-30');
  assert.equal(views.periodEnd('2025-01-01', 'week'), '2025-01-05');
  assert.equal(views.periodKey('2025-01-05', 'week'), '2024-12-30');
  assert.equal(views.periodKey('2025-01-06', 'week'), '2025-01-06');
  const rows = views.revenueBuckets(result, 'week');
  assert.equal(rows.find(r => r.key === '2024-12-30').totalRevenue, 75);
  assert.equal(rows.find(r => r.key === '2024-12-30').calendarDays, 7);
});

test('calendar periods handle leap years independently of the computer timezone', () => {
  for (const zone of ['Pacific/Honolulu', 'Asia/Tokyo', 'Europe/Prague']) {
    process.env.TZ = zone;
    assert.equal(views.periodEnd('2024-02-10', 'month'), '2024-02-29');
    assert.equal(views.periodEnd('2025-02-10', 'month'), '2025-02-28');
    assert.equal(views.periodKey('2025-01-01', 'week'), '2024-12-30');
  }
});

test('day detail keeps 96 physical power intervals and the terminal SOC boundary', () => {
  const data = views.detailSeries([daily[1]], 'day');
  assert.equal(data.rows.length, 96);
  assert.equal(data.socRows.length, 97);
  assert.equal(data.powerUnit, 'MW');
  assert.equal(data.rows[0].charge, -1);
  assert.equal(data.socRows.at(-1).soc, 0);
  assert.equal(data.socRows.at(-1).label, '24:00');
});

test('week summaries convert MW to MWh, average prices and report SOC ranges', () => {
  const data = views.detailSeries(daily.slice(0, 3), 'week');
  assert.equal(data.rows.length, 168);
  assert.equal(data.powerUnit, 'MWh');
  const hour = data.rows.find(r => r.key === '2025-01-01T00');
  assert.equal(hour.charge, -1);
  assert.equal(hour.discharge, 0);
  assert.equal(hour.daa, 25);
  assert.equal(hour.idc, 30);
  assert.equal(hour.ida, null);
  assert.deepEqual(hour.socRange, [0, 1]);
  const gap = data.rows.find(r => r.key === '2025-01-02T00');
  assert.equal(gap.charge, null);
  assert.equal(gap.daa, null);
  assert.equal(gap.socRange, null);
});

test('month/year detail stays bounded and preserves exact energy totals with missing dates', () => {
  const days = daily.slice(1, 3);
  for (const grain of ['month', 'year']) {
    const data = views.detailSeries(days, grain);
    assert.equal(data.rows.length, grain === 'month' ? 31 : 365);
    assert.equal(data.rows.reduce((sum, r) => sum-(r.charge ?? 0), 0), 2);
    assert.equal(data.rows.reduce((sum, r) => sum+(r.discharge ?? 0), 0), 2);
    assert.deepEqual(data.rows[0].socRange, [0, 1]);
  }
});

test('excluded-only and outside-coverage selections remain explicit empty views', () => {
  const missing = views.filterResult(result, { year: '2025', month: '03' });
  assert.equal(missing.daily.length, 0);
  assert.equal(missing.coverage.excludedDays, 1);
  assert.equal(views.revenueBuckets(missing, 'month')[0].totalRevenue, null);
  assert.deepEqual(views.detailPeriods(missing.daily, 'day'), []);
  const empty = views.filterResult(result, { year: '2025', month: '04' });
  assert.equal(empty.coverage.modelledDays, 0);
  assert.deepEqual(views.revenueBuckets(empty, 'month'), []);
});

test('daily and quarter-hour exports contain exactly the selected population and reconcile cash flows', () => {
  const selected = views.filterResult(result, { year: '2025', month: '01' });
  const intervals = exportRows.scheduleRows(selected), days = exportRows.dailyRows(selected);
  assert.equal(intervals.length, 192);
  assert.ok(intervals.every(r => r.datetime.startsWith('2025-01')));
  assert.ok(Math.abs(intervals.reduce((sum, r) => sum+r.revenue_eur, 0)-45) < 1e-9);
  assert.equal(days.length, 3);
  assert.equal(days.filter(r => r.status === 'excluded').length, 1);
  assert.equal(days.reduce((sum, r) => sum+(r.total_revenue_eur ?? 0), 0), 45);
  assert.ok(days.every(r => r.date.startsWith('2025-01')));
});
