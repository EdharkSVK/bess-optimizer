import type { BessParameters, Market, RunState, StudyPreview } from '../types';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}
async function request<T>(url: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try { response = await fetch(url, options); }
  catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new ApiError('Cannot reach the local calculation service. Check that the app is running.', 0);
  }
  let data;
  try { data = await response.json(); }
  catch { throw new ApiError('The calculation service returned an invalid response. Check the backend or Vite proxy.', response.status); }
  if (!response.ok) {
    const detail = data.detail;
    const message = typeof detail === 'string' ? detail : Array.isArray(detail)
      ? detail.map((d: { loc?: string[]; msg?: string }) => `${d.loc?.join('.')}: ${d.msg}`).join('; ')
      : 'The calculation request failed.';
    throw new ApiError(message, response.status);
  }
  return data;
}
export function validateStudy(files: Partial<Record<Market, File>>, timezone: string, product: string) {
  const form = new FormData();
  Object.entries(files).forEach(([market, file]) => { if (file) form.append(market, file); });
  form.append('timezone', timezone); form.append('dayAheadProduct', product);
  return request<StudyPreview>('/api/studies', { method: 'POST', body: form });
}
export function startRun(studyId: string, battery: BessParameters) {
  return request<{ runId: string }>('/api/runs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ studyId, battery }),
  });
}
export function getRun(runId: string, signal: AbortSignal) {
  return request<RunState>(`/api/runs/${runId}`, { signal });
}
