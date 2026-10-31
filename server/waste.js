import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fetchJSON, localDate, addDays } from './utils.js';

const base = 'https://afvalkalender.defryskemarren.nl';
const DAY = 86400000;
export function parseAddress(raw = '') {
  const match = raw.toUpperCase().replace(/\s/g, '').match(/^([1-9]\d{3}[A-Z]{2}):(\d+[A-Z]?(?:-[A-Z0-9]+)?)$/);
  if (!match) throw new Error('Stel AFVALKALENDER_ADRESS in als POSTCODE:HUISNUMMER (eventueel met huisletter/toevoeging)');
  return { postcode: match[1], number: match[2], id: `${match[1]}:${match[2]}` };
}
export function selectAddress(rows, address) {
  if (!Array.isArray(rows)) throw new Error('Ongeldige adresresponse');
  const matches = rows.filter(r => String(r.postcode).toUpperCase().replace(/\s/g, '') === address.postcode && `${r.huisnummer}${r.huisletter || ''}${r.toevoeging ? `-${r.toevoeging}` : ''}`.toUpperCase() === address.number);
  if (matches.length !== 1 || !/^\d+$/.test(String(matches[0].bagid))) throw new Error('Adres niet eenduidig gevonden; controleer huisletter/toevoeging');
  return String(matches[0].bagid);
}
export function normalizeWaste(records, types) {
  if (!Array.isArray(records) || !Array.isArray(types)) throw new Error('Ongeldige afvalkalenderresponse');
  const titles = new Map(types.map(t => [String(t.id), t.title]));
  const unique = new Map();
  for (const r of records) {
    const date = r.ophaaldatum, wasteTypeId = String(r.afvalstroom_id), title = titles.get(wasteTypeId);
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date || typeof title !== 'string' || !title.trim()) throw new Error('Ongeldige inzameldatum of afvalsoort');
    unique.set(`${date}:${wasteTypeId}`, { date, wasteTypeId, title });
  }
  return [...unique.values()].sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
}
export class WasteCalendar {
  constructor(address, directory, get = fetchJSON, now = () => new Date()) {
    this.raw = address; this.directory = directory; this.get = get; this.now = now;
    this.cache = null; this.error = null; this.lastAttemptAt = null; this.failures = 0;
    try { this.address = parseAddress(address); } catch (e) { this.error = e.message; }
    this.key = createHash('sha256').update(this.address?.id || '').digest('hex');
    this.file = `${directory}/waste.json`;
  }
  async start() {
    try {
      const cache = JSON.parse(await readFile(this.file, 'utf8'));
      if (cache.addressKey === this.key && Array.isArray(cache.records) && Array.isArray(cache.years) && Number.isFinite(Date.parse(cache.lastSuccessAt))) this.cache = cache;
    } catch { /* First start or invalid cache. */ }
    try {
      const attempt = JSON.parse(await readFile(`${this.file}.attempt`, 'utf8'));
      if (attempt.addressKey === this.key && Number.isFinite(Date.parse(attempt.lastAttemptAt))) {
        this.lastAttemptAt = attempt.lastAttemptAt; this.failures = Math.max(0, Number(attempt.failures) || 0);
        if (this.address) this.error = attempt.error || null;
      }
    } catch { /* No previous attempt metadata. */ }
    await this.tick();
    this.timer = setInterval(() => this.tick().catch(() => {}), 60000);
  }
  async tick() {
    if (!this.address || this.busy) return;
    const now = this.now(), age = now - new Date(this.cache?.lastSuccessAt || 0);
    if (age < DAY) return;
    if (this.lastAttemptAt && now - new Date(this.lastAttemptAt) < (this.failures >= 3 ? DAY : 60000 * 2 ** this.failures)) return;
    return this.sync();
  }
  async sync() {
    if (!this.address || this.busy) return;
    this.busy = true; this.lastAttemptAt = this.now().toISOString();
    try {
      const bag = selectAddress(await this.get(`${base}/adressen/${encodeURIComponent(this.address.id)}`), this.address);
      const year = Number(localDate(this.now()).slice(0, 4));
      const years = [year];
      if (Number(addDays(localDate(this.now()), 90).slice(0, 4)) > year) years.push(year + 1);
      const [types, next] = await Promise.all([this.get(`${base}/rest/adressen/${bag}/afvalstromen`), this.get(`${base}/rest/adressen/${bag}/ophaaldata`)]);
      const calendars = await Promise.allSettled(years.map(y => this.get(`${base}/rest/adressen/${bag}/kalender/${y}`)));
      const covered = [], all = [...normalizeWaste(next, types)];
      calendars.forEach((r, i) => {
        if (r.status === 'fulfilled') {
          const records = normalizeWaste(r.value, types);
          all.push(...records); if (records.some(v => v.date.startsWith(String(years[i])))) covered.push(years[i]);
        }
      });
      if (!covered.includes(year)) throw new Error('Kalender voor het lopende jaar ontbreekt');
      const records = [...new Map(all.map(r => [`${r.date}:${r.wasteTypeId}`, r])).values()].sort((a, b) => a.date.localeCompare(b.date));
      const cache = { addressKey: this.key, records, years: covered, requestedYears: years, lastAttemptAt: this.lastAttemptAt, lastSuccessAt: this.now().toISOString() };
      await mkdir(this.directory, { recursive: true });
      await writeFile(`${this.file}.tmp`, JSON.stringify(cache), { mode: 0o600 });
      await rename(`${this.file}.tmp`, this.file);
      this.cache = cache; this.failures = 0; this.error = null;
    } catch (e) { this.error = e.message; this.failures++; }
    finally {
      try {
        await mkdir(this.directory, { recursive: true });
        await writeFile(`${this.file}.attempt.tmp`, JSON.stringify({ addressKey: this.key, lastAttemptAt: this.lastAttemptAt, failures: this.failures, error: this.error }), { mode: 0o600 });
        await rename(`${this.file}.attempt.tmp`, `${this.file}.attempt`);
      } catch { this.error ||= 'Afvalcache kon niet worden opgeslagen'; }
      this.busy = false;
    }
  }
  view() {
    const today = localDate(this.now());
    return {
      records: (this.cache?.records || []).filter(r => r.date >= today && r.date <= addDays(today, 90)),
      lastAttemptAt: this.lastAttemptAt || this.cache?.lastAttemptAt || null,
      lastSuccessAt: this.cache?.lastSuccessAt || null,
      stale: !this.cache || this.now() - new Date(this.cache.lastSuccessAt) > DAY * 2,
      missingYears: (this.cache?.requestedYears || []).filter(y => !this.cache.years.includes(y)), error: this.error
    };
  }
  stop() { clearInterval(this.timer); }
}
