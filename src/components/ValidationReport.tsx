import { useState } from 'react';
import { AlertCircle, CheckCircle2, Download } from 'lucide-react';
import { exportValidation } from '../lib/exports';
import type { Coverage } from '../types';

export default function ValidationReport({ coverage }: { coverage: Coverage }) {
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState(100);
  const filtered = coverage.issues.filter(issue => !query.trim() || [issue.market, issue.filename,
    issue.date, issue.row, issue.datetime, issue.price, issue.code, issue.message,
    ...issue.missingTimestamps].join(' ').toLowerCase().includes(query.trim().toLowerCase()));
  const blocked = coverage.blockingFiles.length > 0;
  const unknown = coverage.issues.filter(issue => issue.scope === 'row').length;

  return <section className="bg-white/5 border border-white/10 rounded-xl p-5">
    <h2 className="font-medium flex items-center gap-2 mb-3">
      {coverage.issueCount || blocked ? <AlertCircle className="text-amber-300" size={19} /> : <CheckCircle2 className="text-emerald-400" size={19} />}
      Validation &amp; coverage
    </h2>
    <p className="text-sm text-slate-300"><strong>{coverage.modelledDays}</strong> complete days available · <strong>{coverage.excludedDays}</strong> excluded · <strong>{coverage.issueCount}</strong> validation issues · {coverage.timezone}</p>
    <div className="mt-3 space-y-2">{coverage.files.map(file => <div key={file.market} className="text-xs text-slate-400">
      <span className="text-slate-200">{file.market.toUpperCase()} · {file.filename}</span>
      <span className={file.status === 'unreadable' ? 'text-rose-300' : file.issueCount ? 'text-amber-300' : 'text-emerald-300'}> · {file.status === 'unreadable' ? 'needs correction before running' : `${file.issueCount} issues`}</span>
      <p className="mt-1">{file.firstDate ? `${file.firstDate} – ${file.lastDate}` : 'No readable delivery dates'} · {file.rowCount.toLocaleString()} rows inspected · {file.validRowCount.toLocaleString()} valid rows · complete products {file.intervalsMinutes.join(' / ') || 'none'} min</p>
    </div>)}</div>
    <p className="text-xs text-slate-400 mt-3">Blank prices, invalid values, duplicates and missing intervals exclude the affected day from every uploaded market. The remaining common complete days can be optimized. Prices are never filled or replaced with zero. Clock-change days are excluded; totals are not annualized.</p>
    {!!unknown && <p className="text-amber-200 text-sm mt-3">Some rows have no usable delivery date and were skipped. Their dates cannot be inferred; inspect the reported datetime values. Other dates still need complete delivery grids to qualify.</p>}
    {blocked && <p role="alert" className="text-rose-200 text-sm mt-3">Cannot safely read {coverage.blockingFiles.map(m => m.toUpperCase()).join(', ')}. Correct or remove the affected file, then validate again. Uploaded markets are never silently dropped.</p>}
    {!!coverage.issueCount && <details open className="mt-4 text-sm">
      <summary className="cursor-pointer text-amber-300">Inspect {coverage.issueCount} validation issues</summary>
      <div className="flex flex-wrap items-center gap-3 mt-3">
        <input aria-label="Filter validation issues" placeholder="Filter by file, date, row or issue…" value={query}
          onChange={e => { setQuery(e.target.value); setShown(100); }} className="min-w-0 flex-1 bg-slate-950 border border-white/15 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
        <button type="button" onClick={() => exportValidation(coverage)} className="rounded-md bg-white/10 hover:bg-white/15 px-3 py-2 text-xs flex gap-2 items-center"><Download size={15} />Download all issues (CSV)</button>
      </div>
      <p className="text-xs text-slate-400 mt-2">{filtered.length} matching issues. CSV line numbers include the header; missing rows have no line number. The download includes all issues.</p>
      <div className="overflow-auto max-h-96 mt-3 border border-white/10 rounded-md">
        <table className="w-full text-xs text-left"><thead className="sticky top-0 bg-slate-900 text-slate-300"><tr>{['File / line', 'Delivery / supplied values', 'Problem / action'].map(label => <th key={label} className="p-3 font-medium">{label}</th>)}</tr></thead>
          <tbody>{filtered.slice(0, shown).map((issue, index) => <tr key={`${issue.market}-${issue.row}-${issue.code}-${issue.date}-${index}`} className="border-t border-white/10 align-top">
            <td className="p-3 min-w-32"><p className="text-slate-200 break-all">{issue.market.toUpperCase()} · {issue.filename}</p>
              <p className="text-slate-400 mt-1">{issue.row === null ? 'No source row' : `Line ${issue.row}${issue.endRow && issue.endRow !== issue.row ? `–${issue.endRow}` : ''}`}</p>
              {issue.relatedRow !== null && <p className="text-slate-400 mt-1">First occurrence: line {issue.relatedRow}</p>}</td>
            <td className="p-3 min-w-40 break-all"><p>{issue.date ?? 'Date unknown'}</p>
              {issue.datetime !== null && <p className="text-slate-400 mt-1">Datetime: {issue.datetime || '(empty)'}</p>}
              {issue.price !== null && <p className="text-slate-400 mt-1">Price: {issue.price || '(empty)'}</p>}</td>
            <td className="p-3 min-w-52"><p className="text-amber-200">{issue.message}</p><p className="text-slate-400 mt-1">{issue.scope === 'file' ? 'Correct or remove file before running.' : issue.scope === 'row' ? 'Row skipped; date could not be assigned.' : 'Whole day excluded from all uploaded markets.'}</p>
              {!!issue.missingTimestamps.length && <details className="mt-2"><summary className="cursor-pointer text-blue-300">Show all {issue.missingTimestamps.length} missing delivery starts</summary><ul className="mt-2 space-y-1 text-slate-300">{issue.missingTimestamps.map(stamp => <li key={stamp}>{stamp}</li>)}</ul></details>}</td>
          </tr>)}</tbody>
        </table>
      </div>
      {!filtered.length && <p className="text-slate-400 mt-3">No issues match this filter.</p>}
      {filtered.length > shown && <button type="button" onClick={() => setShown(value => value + 100)} className="mt-3 underline text-blue-300 text-xs">Show next 100 issues ({Math.min(shown, filtered.length)} of {filtered.length} shown)</button>}
    </details>}
    {!!coverage.excludedDays && <details className="mt-3 text-sm"><summary className="cursor-pointer text-amber-300">Inspect all {coverage.excludedDays} excluded dates</summary><ul className="mt-2 max-h-48 overflow-auto text-xs space-y-2 text-slate-300">{coverage.excludedDates.map(day => <li key={day.date}>{day.date}: {day.reasons.join('; ')}</li>)}</ul></details>}
    {!coverage.canRun && !blocked && <p className="text-amber-300 text-sm mt-3">No common complete days. Inspect the issues and adjust the files before running.</p>}
  </section>;
}
