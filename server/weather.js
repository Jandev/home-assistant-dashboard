import { fetchJSON, localDate } from './utils.js';
export class Weather {
  constructor(ha, entity, latitude, longitude) { Object.assign(this, { ha, entity, latitude, longitude }); this.data = null; this.error = null; }
  async refresh() {
    try {
      if (this.entity) {
        const s = this.ha.states.get(this.entity);
        if (!s || ['unknown', 'unavailable'].includes(s.state)) throw new Error('Weer-entiteit niet beschikbaar');
        const response = await this.ha.service('weather', 'get_forecasts', { entity_id: this.entity, type: 'hourly' }, true);
        this.data = { source: 'Home Assistant', current: { temperature: s.attributes.temperature, unit: s.attributes.temperature_unit || '°C', condition: s.state }, hourly: (response.service_response?.[this.entity]?.forecast || []).slice(0, 12).map(f => ({ time: f.datetime, temperature: f.temperature, rain: f.precipitation, probability: f.precipitation_probability })) };
        try {
          const daily = await this.ha.service('weather', 'get_forecasts', { entity_id: this.entity, type: 'daily' }, true);
          this.data.daily = (daily.service_response?.[this.entity]?.forecast || []).map(f => ({ date: localDate(new Date(f.datetime)), min: f.templow, max: f.temperature, condition: f.condition, rain: f.precipitation, probability: f.precipitation_probability })).filter(f => f.date > localDate()).slice(0, 2);
        } catch { this.data.daily = []; }
      } else {
        if (this.latitude === undefined || this.longitude === undefined || this.latitude === '' || this.longitude === '' || !Number.isFinite(Number(this.latitude)) || !Number.isFinite(Number(this.longitude))) throw new Error('Weerlocatie ontbreekt');
        const params = new URLSearchParams({ latitude: this.latitude, longitude: this.longitude, current: 'temperature_2m,weather_code', hourly: 'temperature_2m,precipitation,precipitation_probability', daily: 'weather_code,temperature_2m_min,temperature_2m_max,precipitation_sum,precipitation_probability_max', forecast_days: '3', timezone: 'Europe/Amsterdam', timeformat: 'unixtime' });
        const r = await fetchJSON(`https://api.open-meteo.com/v1/forecast?${params}`);
        if (!Number.isFinite(r.current?.temperature_2m) || !Array.isArray(r.hourly?.time)) throw new Error('Ongeldige weerresponse');
        this.data = { source: 'Open-Meteo', current: { temperature: r.current.temperature_2m, unit: '°C', code: r.current.weather_code }, hourly: r.hourly.time.map((time, i) => ({ time: new Date(time * 1000).toISOString(), temperature: r.hourly.temperature_2m[i], rain: r.hourly.precipitation[i], probability: r.hourly.precipitation_probability[i] })).filter(f => Date.parse(f.time) >= Date.now()).slice(0, 12), daily: (r.daily?.time || []).map((time, i) => ({ date: localDate(new Date(time * 1000)), min: r.daily.temperature_2m_min[i], max: r.daily.temperature_2m_max[i], code: r.daily.weather_code[i], rain: r.daily.precipitation_sum[i], probability: r.daily.precipitation_probability_max[i] })).filter(f => f.date > localDate()).slice(0, 2) };
      }
      this.lastSuccessAt = new Date().toISOString(); this.error = null;
    } catch { this.error = 'Weer kon niet worden bijgewerkt'; }
  }
  view() { return { ...this.data, error: this.error, lastSuccessAt: this.lastSuccessAt || null, stale: !this.lastSuccessAt || Date.now() - Date.parse(this.lastSuccessAt) > 3600000 }; }
}
