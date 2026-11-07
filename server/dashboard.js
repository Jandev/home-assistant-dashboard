import { houseRooms, houseState } from './house.js';
import { measurement, power, numeric, localDate, midnight, addDays, namesIn } from './utils.js';
import { powerColumns } from './history.js';

export const available = s => !!s && !['unknown', 'unavailable'].includes(s.state);
export function meterTotal(history, current, start, tolerance = 0) {
  const first = history[0], initial = numeric(first), latest = numeric(current);
  if (initial === null || latest === null || latest < initial || !Number.isFinite(Date.parse(first.last_changed)) || Date.parse(first.last_changed) > Date.parse(start) + 60000) return null;
  let high = initial;
  for (const row of [...history, current]) {
    const n = numeric(row); if (n === null) continue;
    if (high - n > tolerance + 1e-7) return null;
    high = Math.max(high, n);
  }
  return latest - initial;
}
export function entityView(s) {
  if (!s) return null;
  const a = s.attributes;
  return { id: s.entity_id, name: a.friendly_name || s.entity_id, state: s.state, available: available(s), updatedAt: s.last_updated,
    unit: a.unit_of_measurement, deviceClass: a.device_class, brightness: a.brightness,
    color: a.rgb_color ? '#' + a.rgb_color.map(v => Math.round(v).toString(16).padStart(2, '0')).join('') : '#ffffff',
    colorable: a.supported_color_modes?.some(mode => ['xy', 'hs', 'rgb', 'rgbw', 'rgbww'].includes(mode)),
    dimmable: a.supported_color_modes?.some(mode => mode !== 'onoff'),
    temperature: a.current_temperature, title: a.media_title, artist: a.media_artist,
    duration: a.media_duration, position: a.media_position, positionUpdatedAt: a.media_position_updated_at,
    volume: a.volume_level, features: a.supported_features || 0,
    artwork: typeof a.entity_picture === 'string' && a.entity_picture.startsWith('/api/') ? `/api/artwork/${encodeURIComponent(s.entity_id)}` : null };
}
export class Dashboard {
  constructor(ha, config) { this.ha = ha; this.config = config; this.calendar = { events: [], error: null, lastSuccessAt: null }; this.daily = {}; this.historyCache = new Map(); }
  async refreshCalendar() {
    try {
      const today = localDate();
      const events = await this.ha.request(`calendars/${encodeURIComponent(this.config.calendar)}?${new URLSearchParams({ start: midnight(today), end: midnight(addDays(today, 14)) })}`);
      if (!Array.isArray(events)) throw new Error();
      this.calendar = { events: events.map(e => ({ title: e.summary || 'Afspraak', description: e.description || '', location: e.location || '', start: e.start?.dateTime || e.start?.date, end: e.end?.dateTime || e.end?.date, allDay: !!e.start?.date, names: namesIn(e.summary || '', this.config.calendarNames) })).sort((a, b) => {
        const dayA = a.allDay ? a.start : localDate(new Date(a.start)), dayB = b.allDay ? b.start : localDate(new Date(b.start));
        return dayA.localeCompare(dayB) || Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start);
      }), error: null, lastSuccessAt: new Date().toISOString() };
    } catch { this.calendar.error = 'Agenda Gezin is niet beschikbaar'; }
  }
  async history(period) {
    const days = { day: 1, week: 7, month: 30 }[period];
    if (!days) throw new Error('Ongeldige periode');
    const cached = this.historyCache.get(period);
    if (cached && Date.now() - cached.at < 300000) return cached.data;
    const ids = [this.config.energy.solar, this.config.energy.grid, this.config.energy.home].filter(Boolean);
    const start = new Date(Date.now() - days * 86400000).toISOString();
    const data = await this.ha.request(`history/period/${encodeURIComponent(start)}?${new URLSearchParams({ filter_entity_id: ids.join(',') })}`);
    const end = new Date().toISOString();
    const series = ids.map(id => {
      const rows = data.find(r => r[0]?.entity_id === id) || [];
      return { id, name: this.ha.states.get(id)?.attributes.friendly_name || id, points: powerColumns(rows, start, end, period) };
    });
    this.historyCache.set(period, { at: Date.now(), data: series }); return series;
  }
  async refreshDaily() {
    const e = this.config.energy, ids = [e.solarMeter, e.importMeter, e.exportMeter, e.gasMeter].filter(Boolean);
    try {
      const day = localDate(), start = midnight(day);
      const rows = await this.ha.request(`history/period/${encodeURIComponent(start)}?${new URLSearchParams({ filter_entity_id: ids.join(',') })}`);
      const result = { day, periodStart: start, periodEnd: new Date().toISOString(), lastSuccessAt: new Date().toISOString(), warnings: [] };
      for (const [key, id] of Object.entries({ solar: e.solarMeter, import: e.importMeter, export: e.exportMeter, gas: e.gasMeter })) {
        const history = rows.find(r => r[0]?.entity_id === id) || [], current = this.ha.states.get(id);
        const lastValid = history.findLast(row => numeric(row) !== null);
        const stale = numeric(current) === null;
        const endReading = stale ? lastValid : current;
        const unit = endReading?.attributes?.unit_of_measurement || current?.attributes.unit_of_measurement;
        // A valid midnight baseline is required; never label a lifetime total as a daily total.
        const validHistory = history.filter(r => numeric(r) !== null);
        const toleranceWh = key === 'solar' ? Math.max(0, Number(e.solarMeterDecreaseToleranceWh) || 0) : 0;
        const delta = meterTotal(history, endReading, start, toleranceWh / (unit === 'kWh' ? 1000 : 1));
        if (delta === null && validHistory.some((r, i) => i && numeric(r) < numeric(validHistory[i - 1]))) result.warnings.push(`${key === 'solar' ? 'Opwek' : key === 'gas' ? 'Gas' : key === 'import' ? 'Netafname' : 'Teruglevering'}: teller liep terug; dagtotaal niet betrouwbaar.`);
        if (delta !== null) {
          if (key === 'gas' ? unit === 'm³' : ['Wh', 'kWh'].includes(unit)) {
            result[key] = { value: delta / (unit === 'Wh' ? 1000 : 1), unit: key === 'gas' ? 'm³' : 'kWh', stale, updatedAt: endReading?.last_updated || endReading?.last_changed || null,
              startReading: numeric(history[0]), endReading: numeric(endReading), readingUnit: unit, periodStart: start };
            if (stale) result.warnings.push(`${key === 'solar' ? 'Opwekbron' : key === 'gas' ? 'Gasmeter' : key === 'import' ? 'Netafnamemeter' : 'Teruglevermeter'} offline: laatst gemeten dagtotaal wordt getoond.`);
          }
        }
      }
      this.daily = result;
    } catch {
      this.daily.error = 'Dagtotalen konden niet worden bijgewerkt; eventuele waarden zijn de laatste geldige metingen.';
      for (const key of ['solar', 'home', 'import', 'export', 'gas']) if (this.daily[key]) this.daily[key].stale = true;
    }
  }
  view(waste, weather) {
    const { ha, config: c } = this, get = id => ha.states.get(id), e = c.energy;
    const measuredSolar = power(get(e.solar)), solarAssumedZero = measuredSolar === null && e.assumeMissingSolarZero === true;
    const solar = solarAssumedZero ? 0 : measuredSolar, rawGrid = power(get(e.grid)), grid = rawGrid === null ? null : rawGrid * (e.gridPositiveIsImport ? 1 : -1);
    const directHome = power(get(e.home));
    const home = directHome ?? (e.deriveHome && solar !== null && grid !== null && solar + grid >= 0 ? solar + grid : null);
    const directConsumption = solar === 0 ? 0 : solar !== null && grid !== null ? Math.max(0, solar - Math.max(0, -grid)) : null;
    const rooms = houseRooms(ha, c);
    const ids = new Set([...rooms.flatMap(r => r.entities), ...c.quickActions.flatMap(a => a.entities), ...c.speakers.map(s => s.entity), ...c.cameras.map(s => s.entity), ...[e.solar, e.grid, e.home, c.indoorTemperature], ...e.consumers]);
    const daily = this.daily.day === localDate() ? structuredClone(this.daily) : {};
    if (e.deriveHome && daily.solar && daily.import && daily.export && daily.solar.value + daily.import.value >= daily.export.value) daily.home = { value: daily.solar.value + daily.import.value - daily.export.value, unit: 'kWh', stale: [daily.solar, daily.import, daily.export].some(value => value.stale), updatedAt: [daily.solar, daily.import, daily.export].filter(value => value.stale).map(value => value.updatedAt).filter(Boolean).sort()[0] || daily.lastSuccessAt };
    return {
      location: c.location, calendarNames: c.calendarNames || [], connection: { live: ha.connected, lastSuccessAt: ha.lastSuccessAt, stale: !ha.lastSuccessAt || Date.now() - Date.parse(ha.lastSuccessAt) > 90000 },
      entities: Object.fromEntries([...ids].filter(Boolean).map(id => [id, entityView(houseState(ha, c, id))])),
      rooms, quickActions: c.quickActions, speakers: c.speakers, cameras: c.cameras,
      scenes: [...ha.states.values()].filter(s => s.entity_id.startsWith('scene.')).map(entityView),
      temperature: measurement(get(c.indoorTemperature)),
      energy: { solar, solarAssumedZero, directConsumption, grid, home, daily, consumers: e.consumers.map(id => ({ name: get(id)?.attributes.friendly_name || id, ...measurement(get(id)) })), allConsumers: [...ha.states.values()].filter(s => s.entity_id.startsWith('sensor.') && s.attributes.device_class === 'power' && ['W', 'kW'].includes(s.attributes.unit_of_measurement) && ![e.solar, e.grid, e.home].includes(s.entity_id) && !/fase|phase/i.test(s.entity_id + ' ' + s.attributes.friendly_name)).map(s => ({ id: s.entity_id, name: s.attributes.friendly_name || s.entity_id, ...measurement(s) })).sort((a,b) => a.name.localeCompare(b.name, 'nl')), updatedAt: ha.lastSuccessAt },
      calendar: this.calendar, weather: weather.view(), waste: waste.view(),
      music: { radio: ha.supportsRadio(), radioSpeakers: c.speakers.filter(s => ha.isMusicPlayer(s.entity)).map(s => s.entity), search: ha.hasService('music_assistant', 'search') && !!(c.musicAssistantEntryId || ha.musicEntry(c.speakers)), library: ha.hasService('music_assistant', 'get_library') && !!(c.musicAssistantEntryId || ha.musicEntry(c.speakers)), queue: ha.hasService('music_assistant', 'get_queue') }
    };
  }
}
