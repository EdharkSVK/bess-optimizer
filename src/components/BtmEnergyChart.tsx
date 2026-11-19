import Papa from 'papaparse';
import { Area, Bar, CartesianGrid, ComposedChart, Legend, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { download } from '../lib/exports';
import type { BtmEnergyFlows } from '../lib/solar';
import { number, secondary } from '../lib/solarUi';

const dispatchSeries = [
  { key: 'pvToLoadMW', name: 'PV to site', color: '#fbbf24' },
  { key: 'batteryToLoadMW', name: 'BESS discharge', color: '#2dd4bf' },
  { key: 'exportMW', name: 'PV export', color: '#60a5fa' },
  { key: 'batteryCharge', name: 'PV to battery', color: '#f472b6' },
] as const;

export default function BtmEnergyChart({ flows, filename, profile, hourlyBars }: {
  flows: BtmEnergyFlows[];
  filename: string;
  profile: string;
  hourlyBars: boolean;
}) {
  const rows = flows.map((flow, hour) => ({
    ...flow,
    hour: `${String(hour).padStart(2, '0')}:00`,
    batteryCharge: 0 - flow.pvChargeMW,
  }));

  function exportChart() {
    download(filename, Papa.unparse(rows.map(row => ({
      profile,
      hour_utc: row.hour,
      site_consumption_mw: row.loadMW,
      pv_to_site_mw: row.pvToLoadMW,
      bess_discharge_mw: row.batteryToLoadMW,
      pv_export_mw: row.exportMW,
      bess_charge_mw: row.batteryCharge,
    }))));
  }

  return <div className="space-y-3">
    <div className="flex justify-end">
      <button type="button" className={secondary} onClick={exportChart}>Export energy chart CSV</button>
    </div>
    <div className="h-[360px] w-full" role="img"
      aria-label="Hourly site consumption, stacked production and export, and PV-to-battery charging in megawatts">
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <ComposedChart data={rows} stackOffset="sign" barCategoryGap="12%" margin={{ top: 8, right: 16, bottom: 8, left: 12 }}>
          <CartesianGrid vertical={false} stroke="#26344a" strokeDasharray="3 5" />
          <XAxis dataKey="hour" minTickGap={18} tick={{ fill: '#94a3b8', fontSize: 11 }}
            label={{ value: 'UTC', position: 'insideBottomRight', offset: -5, fill: '#94a3b8', fontSize: 11 }} />
          <YAxis tick={{ fill: '#94a3b8', fontSize: 11 }} tickFormatter={value => number(Number(value), 3)}
            label={{ value: 'MW', angle: -90, position: 'insideLeft', fill: '#94a3b8', fontSize: 11 }} />
          <ReferenceLine y={0} stroke="#64748b" zIndex={450} />
          <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #475569', borderRadius: 8 }}
            labelStyle={{ color: '#e2e8f0' }} labelFormatter={hour => `${hour} UTC`}
            formatter={value => typeof value === 'number' ? `${number(value, 4)} MW` : String(value)} />
          <Legend wrapperStyle={{ fontSize: 12, paddingTop: 10 }} />
          {dispatchSeries.map(({ key, name, color }) => hourlyBars
            ? <Bar key={key} dataKey={key} stackId="production" name={name} fill={color} isAnimationActive={false} />
            : <Area key={key} type="linear" dataKey={key} stackId={key === 'batteryCharge' ? undefined : 'production'}
                baseValue={0} name={name}
                stroke={color} strokeWidth={1.5} fill={color} fillOpacity={0.38} isAnimationActive={false} />)}
          <Line dataKey="loadMW" name="Site consumption" stroke="#f1f5f9" strokeWidth={2.5} dot={false} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  </div>;
}
