export const timezone = 'Europe/Amsterdam';
export const localDate = (date = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
export function addDays(day, n) { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
export function midnight(day) {
  const base = Date.parse(`${day}T00:00:00Z`);
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', hourCycle: 'h23' }).format(new Date(base)));
  return new Date(base - hour * 3600000).toISOString();
}
export function numeric(s) { return s && s.state !== '' && Number.isFinite(Number(s.state)) ? Number(s.state) : null; }
export function measurement(s) { return { value: numeric(s), unit: s?.attributes?.unit_of_measurement ?? '', updatedAt: s?.last_updated ?? null }; }
export function power(s) { const n = numeric(s); return n === null ? null : s.attributes.unit_of_measurement === 'kW' ? n * 1000 : s.attributes.unit_of_measurement === 'W' ? n : null; }
export async function fetchJSON(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (!response.ok) throw new Error(`Bron geeft HTTP ${response.status}`);
  return response.json();
}
export const namesIn = (title, names = []) => {
  const words = new Set(String(title).toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
  return names.filter(name => words.has(String(name).toLocaleLowerCase()));
};
