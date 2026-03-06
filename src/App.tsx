import React, { useState } from 'react';
import Papa from 'papaparse';
import { Icons } from './components/icons';
import { optimizeBessDispatch } from './lib/optimizer';
import { BessParameters, PriceDataPoint, OptimizationResult } from './types';
import { LineChart, Line, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, ComposedChart } from 'recharts';

function App() {
  const [prices, setPrices] = useState<PriceDataPoint[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [result, setResult] = useState<OptimizationResult | null>(null);

  const [params, setParams] = useState<BessParameters>({
    capacityMWh: 4,
    maxPowerMW: 1,
    roundtripEfficiency: 0.85,
    startingSoc: 0,
    lookaheadWindowHours: 24,
    dataIntervalMinutes: 60,
  });

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsProcessing(true);
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        // Assuming CSV has columns 'datetime' and 'price'
        const parsedData: PriceDataPoint[] = results.data.map((row: any) => ({
          datetime: row.datetime || row.time || row.Date || Object.values(row)[0],
          price: parseFloat(row.price || row.Price || Object.values(row)[1]),
        })).filter(d => !isNaN(d.price));

        setPrices(parsedData);
        setIsProcessing(false);
      },
      error: (error) => {
        console.error("Error parsing CSV:", error);
        setIsProcessing(false);
      }
    });
  };

  const runOptimization = () => {
    if (prices.length === 0) return;
    setIsProcessing(true);

    // Use a timeout to allow UI update before heavy freezing sync calculation
    setTimeout(() => {
      try {
        const optResult = optimizeBessDispatch(prices, params);
        setResult(optResult);
      } catch (err) {
        console.error("Optimization failed:", err);
        alert("Optimization failed. Dataset might be too large or constraints invalid.");
      } finally {
        setIsProcessing(false);
      }
    }, 100);
  };

  const exportResult = () => {
    if (!result) return;
    const csv = Papa.unparse(result.schedule);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", "bess_dispatch_schedule.csv");
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col font-sans selection:bg-primary/30">
      {/* Header */}
      <header className="border-b border-white/10 bg-black/20 backdrop-blur-md sticky top-0 z-50">
        <div className="container mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-600/20 rounded-lg text-blue-400">
              <Icons.BatteryCharging className="w-6 h-6" />
            </div>
            <h1 className="text-xl font-semibold tracking-tight">FlexOptima BESS App</h1>
          </div>
          <div className="flex items-center gap-4 text-sm text-muted-foreground">
            Linear Programming Optimizer
          </div>
        </div>
      </header>

      <main className="flex-1 container mx-auto px-6 py-8 grid grid-cols-1 lg:grid-cols-12 gap-8">

        {/* Left Sidebar - Config */}
        <div className="lg:col-span-3 space-y-6">
          <div className="bg-white/5 border border-white/10 rounded-xl p-5 shadow-2xl backdrop-blur-sm">
            <h2 className="text-lg font-medium flex items-center gap-2 mb-4">
              <Icons.Upload className="w-5 h-5 text-emerald-400" />
              Upload Data
            </h2>
            <div className="group relative border-2 border-dashed border-white/20 hover:border-emerald-500/50 rounded-lg p-6 text-center transition-all cursor-pointer bg-black/20 hover:bg-emerald-500/5">
              <input
                type="file"
                accept=".csv"
                onChange={handleFileUpload}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
              />
              <Icons.FileBarChart className="w-8 h-8 mx-auto mb-3 text-muted-foreground group-hover:text-emerald-400 transition-colors" />
              <p className="text-sm font-medium">Select historical prices CSV</p>
              <p className="text-xs text-muted-foreground mt-1">Expected columns: datetime, price</p>
            </div>
            {prices.length > 0 && (
              <div className="mt-3 text-sm text-emerald-400 flex items-center gap-2 bg-emerald-400/10 px-3 py-2 rounded-md">
                <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                Loaded {prices.length} data points
              </div>
            )}
          </div>

          <div className="bg-white/5 border border-white/10 rounded-xl p-5 shadow-2xl backdrop-blur-sm">
            <h2 className="text-lg font-medium flex items-center gap-2 mb-4">
              <Icons.Settings2 className="w-5 h-5 text-blue-400" />
              BESS Parameters
            </h2>

            <div className="space-y-4">
              <div>
                <label className="text-xs font-semibold text-muted-foreground mb-1.5 block uppercase tracking-wider">Capacity (MWh)</label>
                <input
                  type="number"
                  value={params.capacityMWh}
                  onChange={e => setParams({ ...params, capacityMWh: Number(e.target.value) })}
                  className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-muted-foreground mb-1.5 block uppercase tracking-wider">Max Power (MW)</label>
                <input
                  type="number"
                  value={params.maxPowerMW}
                  onChange={e => setParams({ ...params, maxPowerMW: Number(e.target.value) })}
                  className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-muted-foreground mb-1.5 block uppercase tracking-wider">Roundtrip Efficiency (%)</label>
                <input
                  type="number"
                  value={params.roundtripEfficiency * 100}
                  onChange={e => setParams({ ...params, roundtripEfficiency: Number(e.target.value) / 100 })}
                  className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-muted-foreground mb-1.5 block uppercase tracking-wider">Data Interval</label>
                  <select
                    value={params.dataIntervalMinutes}
                    onChange={e => setParams({ ...params, dataIntervalMinutes: Number(e.target.value) })}
                    className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 appearance-none"
                  >
                    <option value={60}>1 Hour</option>
                    <option value={15}>15 Min</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs font-semibold text-muted-foreground mb-1.5 block uppercase tracking-wider">Lookahead</label>
                  <select
                    value={params.lookaheadWindowHours}
                    onChange={e => setParams({ ...params, lookaheadWindowHours: Number(e.target.value) })}
                    className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 appearance-none"
                  >
                    <option value={24}>24 Hours</option>
                    <option value={48}>48 Hours</option>
                    <option value={168}>1 Week</option>
                  </select>
                </div>
              </div>
            </div>

            <button
              onClick={runOptimization}
              disabled={prices.length === 0 || isProcessing}
              className="w-full mt-6 bg-blue-600 hover:bg-blue-500 text-white font-medium py-2.5 rounded-lg flex items-center justify-center gap-2 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-[0_0_20px_rgba(37,99,235,0.2)] hover:shadow-[0_0_25px_rgba(37,99,235,0.4)]"
            >
              {isProcessing ? (
                <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                <Icons.Play className="w-4 h-4" />
              )}
              {isProcessing ? 'Optimizing...' : 'Run Optimization'}
            </button>
          </div>
        </div>

        {/* Right Content - Results */}
        <div className="lg:col-span-9 space-y-6">
          {result ? (
            <>
              {/* KPIs */}
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div className="bg-white/5 border border-white/10 rounded-xl p-5 relative overflow-hidden group">
                  <div className="absolute inset-0 bg-gradient-to-br from-emerald-500/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                  <div className="text-muted-foreground text-sm font-medium mb-1 flex items-center gap-2">
                    <Icons.DollarSign className="w-4 h-4" /> Total Revenue
                  </div>
                  <div className="text-2xl font-bold text-white">€{result.totalRevenue.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
                </div>
                <div className="bg-white/5 border border-white/10 rounded-xl p-5 relative overflow-hidden group">
                  <div className="absolute inset-0 bg-gradient-to-br from-rose-500/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                  <div className="text-muted-foreground text-sm font-medium mb-1">Total Cost</div>
                  <div className="text-2xl font-bold text-white">€{result.totalCost.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
                </div>
                <div className="bg-white/5 border border-white/10 rounded-xl p-5 relative overflow-hidden group">
                  <div className="absolute inset-0 bg-gradient-to-br from-blue-500/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                  <div className="text-muted-foreground text-sm font-medium mb-1">Net Profit</div>
                  <div className="text-2xl font-bold text-emerald-400">€{result.netProfit.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
                </div>
                <div className="bg-white/5 border border-white/10 rounded-xl p-5 relative overflow-hidden group">
                  <div className="absolute inset-0 bg-gradient-to-br from-purple-500/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                  <div className="text-muted-foreground text-sm font-medium mb-1 flex items-center gap-2">
                    <Icons.Activity className="w-4 h-4" /> Est. Cycles
                  </div>
                  <div className="text-2xl font-bold text-white">{result.cyclesCount.toFixed(1)}</div>
                </div>
              </div>

              {/* Chart */}
              <div className="bg-white/5 border border-white/10 rounded-xl p-6 shadow-2xl backdrop-blur-sm">
                <div className="flex items-center justify-between mb-6">
                  <h3 className="text-lg font-medium">Dispatch Schedule & Prices</h3>
                  <button
                    onClick={exportResult}
                    className="text-sm bg-white/10 hover:bg-white/20 px-4 py-1.5 rounded-md flex items-center gap-2 transition-colors"
                  >
                    <Icons.Download className="w-4 h-4" /> Export CSV
                  </button>
                </div>

                <div className="h-[400px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={result.schedule} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" vertical={false} />
                      <XAxis
                        dataKey="datetime"
                        stroke="rgba(255,255,255,0.4)"
                        tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 12 }}
                        tickFormatter={(val) => val.split(' ')[0]} // Simplify date display
                        minTickGap={30}
                      />
                      <YAxis
                        yAxisId="price"
                        orientation="left"
                        stroke="rgba(255,255,255,0.4)"
                        tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 12 }}
                      />
                      <YAxis
                        yAxisId="soc"
                        orientation="right"
                        stroke="rgba(255,255,255,0.4)"
                        tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 12 }}
                        domain={[0, params.capacityMWh]}
                      />
                      <Tooltip
                        contentStyle={{ backgroundColor: '#0f172a', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px' }}
                        itemStyle={{ color: '#e2e8f0' }}
                        labelStyle={{ color: '#94a3b8', marginBottom: '8px' }}
                      />
                      {/* Price Line */}
                      <Line yAxisId="price" type="stepAfter" dataKey="price" stroke="#3b82f6" strokeWidth={2} dot={false} name="Price (€/MWh)" />
                      {/* SOC Area */}
                      <Area yAxisId="soc" type="stepAfter" dataKey="soc" fill="rgba(168,85,247,0.2)" stroke="#a855f7" strokeWidth={2} name="State of Charge (MWh)" />
                      {/* Charge/Discharge Bars */}
                      <Bar yAxisId="soc" dataKey="dischargeMW" fill="#10b981" name="Discharge (MW)" />
                      <Bar yAxisId="soc" dataKey="chargeMW" fill="#f43f5e" name="Charge (MW)" />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </>
          ) : (
            <div className="h-full min-h-[500px] border border-dashed border-white/10 rounded-xl flex items-center justify-center bg-white/5 backdrop-blur-sm">
              <div className="text-center opacity-50">
                <Icons.Activity className="w-12 h-12 mx-auto mb-4" />
                <p className="text-lg font-medium">Awaiting Data & Optimization</p>
                <p className="text-sm">Upload historical prices and run the optimizer.</p>
              </div>
            </div>
          )}
        </div>

      </main>
    </div>
  );
}

export default App;
