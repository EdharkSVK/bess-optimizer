import { Bar, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { cashflowLegs } from '../lib/resultViews';
import type { CashflowLeg, CashflowPoint } from '../lib/resultViews';
import type { Market } from '../types';

const legLabels: Record<CashflowLeg, string> = {
  buy: 'Buy · new', sell: 'Sell · new', buyToClose: 'Buy · close', sellToClose: 'Sell · close',
};
const closing = (leg: CashflowLeg) => leg === 'buyToClose' || leg === 'sellToClose';
const money = (value: number) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 }).format(value);
const number = (value: number) => new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 }).format(value);
const tick = { fontSize: 11, fill: '#94a3b8' };

interface Props {
  rows: CashflowPoint[]; enabledMarkets: Market[]; syncId: string;
  colors: Record<Market, string>; labels: Record<Market, string>;
}

function CashflowTooltip({ active, label, rows, enabledMarkets, colors, labels }: Props & { active?: boolean; label?: string | number }) {
  const row = active ? rows.find(point => point.key === String(label)) : undefined;
  if (!row) return null;
  return <div className="rounded-lg border border-slate-600 bg-slate-950 p-3 text-xs shadow-lg max-w-sm">
    <p className="font-medium text-slate-100 mb-2">{row.label}</p>
    {row.net === null ? <p>No modelled data</p> : <>
      <table className="text-right w-full"><thead><tr className="text-slate-400"><th className="text-left pr-3 font-normal">Trade</th><th className="pr-3 font-normal">MWh</th><th className="pr-3 font-normal">Receipts</th><th className="font-normal">Payments</th></tr></thead><tbody>
        {enabledMarkets.map(market => {
          const trades = row.cashByMarket[market];
          if (!trades || !cashflowLegs.some(leg => trades[leg].energyMWh > 1e-8)) return null;
          return cashflowLegs.filter(leg => trades[leg].energyMWh > 1e-8).map(leg => <tr key={`${market}-${leg}`}>
            <td className="text-left pr-3 pt-1 whitespace-nowrap" style={{ color: colors[market] }}>{labels[market]} · {legLabels[leg]}</td>
            <td className="pr-3 pt-1">{number(trades[leg].energyMWh)}</td><td className="pr-3 pt-1 text-emerald-300">{money(trades[leg].receipts)}</td><td className="pt-1 text-rose-300">{money(Math.abs(trades[leg].payments))}</td>
          </tr>);
        })}
      </tbody></table>
      <p className="text-slate-100 mt-2">Net trading cash flow: {money(row.net)}</p>
      <p className="text-amber-300 mt-1">Physical wear allowance: {money(row.wearCost ?? 0)}</p>
      <p className="text-emerald-300 mt-1">Wear-adjusted margin: {money(row.wearAdjustedMargin ?? 0)}</p>
    </>}
  </div>;
}

export default function TradeCashflowChart(props: Props) {
  const { rows, enabledMarkets, syncId, colors, labels } = props;
  const patternId = (market: Market) => `${syncId.replace(/[^a-zA-Z0-9_-]/g, '')}-close-${market}`;
  return <section aria-label="Trading cash flows" className="mt-5">
    <h3 className="text-sm text-slate-300 mb-2">Trading revenue &amp; purchase costs · EUR</h3>
    <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs mb-2" aria-label="Trading cash flow legend">
      {enabledMarkets.map(market => <span key={market} style={{ color: colors[market] }}>● {labels[market]}</span>)}
      <span className="flex items-center gap-1.5 text-slate-300"><svg width="16" height="12" aria-hidden="true"><rect width="16" height="12" fill="#94a3b8" /></svg>New positions</span>
      <span className="flex items-center gap-1.5 text-slate-300"><svg width="16" height="12" aria-hidden="true"><rect width="16" height="12" fill="#94a3b830" /><path d="M-4 12L8 0M2 12L14 0M8 12L20 0" stroke="#cbd5e1" strokeWidth="2" /></svg>Financial position closures</span>
      <span className="text-slate-300">╌ Net trading cash flow</span>
    </div>
    <p className="text-xs text-slate-400 mb-3">Receipts above zero; payments below zero, before wear and other costs. Hover to see buys and sells by market. Hatched bars close earlier positions. New positions can be closed later; final physical dispatch is shown above.</p>
    <div className="h-64" data-testid="cashflow-chart"><ResponsiveContainer><ComposedChart data={rows} syncId={syncId} syncMethod="value" stackOffset="sign">
      <defs>{enabledMarkets.map(market => <pattern key={market} id={patternId(market)} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width="6" height="6" fill={colors[market]} fillOpacity="0.2" /><line x1="0" y1="0" x2="0" y2="6" stroke={colors[market]} strokeWidth="2.5" />
      </pattern>)}</defs>
      <CartesianGrid stroke="#ffffff12" vertical={false} /><XAxis dataKey="key" interval="preserveStartEnd" minTickGap={55} tick={tick} tickFormatter={key => rows.find(row => row.key === key)?.tick ?? key} />
      <YAxis width={60} tick={tick} tickFormatter={value => number(Number(value))} /><ReferenceLine y={0} stroke="#64748b" />
      <Tooltip cursor={{ fill: '#ffffff08' }} content={({ active, label }) => <CashflowTooltip {...props} active={active} label={label} />} />
      {enabledMarkets.flatMap(market => cashflowLegs.flatMap(leg => (['receipts', 'payments'] as const).map(direction =>
        <Bar key={`${market}-${leg}-${direction}`} dataKey={`cashByMarket.${market}.${leg}.${direction}`} name={`${labels[market]} · ${legLabels[leg]} · ${direction}`} stackId="cash"
          fill={closing(leg) ? `url(#${patternId(market)})` : colors[market]} stroke={closing(leg) ? colors[market] : undefined} strokeWidth={closing(leg) ? .5 : 0} isAnimationActive={false} />
      )))}
      <Line dataKey="net" name="Net trading cash flow (EUR)" stroke="#e2e8f0" strokeDasharray="4 3" strokeWidth={1.5} dot={false} connectNulls={false} isAnimationActive={false} />
    </ComposedChart></ResponsiveContainer></div>
  </section>;
}
