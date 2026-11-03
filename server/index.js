import { houseRooms, houseState } from './house.js';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { HomeAssistant } from './ha.js';
import { Dashboard, available } from './dashboard.js';
import { WasteCalendar } from './waste.js';
import { Weather } from './weather.js';
import { musicSource } from './music.js';
import { createScreensaver, resolvePhotoDirectory } from './screensaver.js';

export async function createApp({ env = process.env, config, ha } = {}) {
  config ||= JSON.parse(await readFile(env.CONFIG_FILE || 'config/dashboard.json', 'utf8'));
  ha ||= new HomeAssistant(env.HOMEASSISTANT_URL || env.HOMEASSISTANT_ADDRESS, env.HOMEASSISTANT_API_KEY);
  const waste = new WasteCalendar(env.AFVALKALENDER_ADRESS, env.DATA_DIR || './data');
  const weather = new Weather(ha, config.weather, env.WEATHER_LATITUDE, env.WEATHER_LONGITUDE);
  const dashboard = new Dashboard(ha, config);
  const screensaverConfig = { enabled: true, idleSeconds: 120, slideSeconds: 15, transition: 'kenburns', showClock: true, showWeather: true, photoDirectory: '/app/photos', ...config.screensaver,
    nightMode: { enabled: true, startTime: '23:00', endTime: '07:00', timezone: 'Europe/Amsterdam', screenOff: true, wakeOnTouch: true, ...config.screensaver?.nightMode } };
  const screensaver = createScreensaver({ photoDirectory: resolvePhotoDirectory(screensaverConfig.photoDirectory), dataDirectory: env.DATA_DIR || './data' });
  const allowedIds = () => new Set([...config.quickActions.flatMap(a => a.entities), ...houseRooms(ha, config).flatMap(r => r.entities), ...[...ha.states.keys()].filter(id => id.startsWith('scene.')), ...config.speakers.map(s => s.entity)]);
  const root = resolve('dist');
  function json(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }
  async function body(req) {
    let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 16384) throw new Error('Aanvraag te groot'); }
    return JSON.parse(raw);
  }
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob: https://*.mzstatic.com; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, 'http://dashboard.local'), path = url.pathname;
      if (req.method === 'GET' && path === '/health') return json(res, 200, { status: 'ok' });
      if (req.method === 'GET' && path === '/api/dashboard') return json(res, 200, { ...dashboard.view(waste, weather), screensaver: {
        enabled: screensaverConfig.enabled, idleSeconds: screensaverConfig.idleSeconds, slideSeconds: screensaverConfig.slideSeconds,
        transition: screensaverConfig.transition, showClock: screensaverConfig.showClock, showWeather: screensaverConfig.showWeather,
        nightMode: screensaverConfig.nightMode
      } });
      if (req.method === 'GET' && path === '/api/screensaver/photos') {
        if (!screensaverConfig.enabled) return json(res, 404, { error: 'Screensaver uitgeschakeld' });
        res.setHeader('Cache-Control', 'no-store');
        return json(res, 200, await screensaver.scan());
      }
      if (req.method === 'GET' && path.startsWith('/api/screensaver/image/')) {
        if (!screensaverConfig.enabled) return json(res, 404, { error: 'Screensaver uitgeschakeld' });
        const id = path.slice('/api/screensaver/image/'.length);
        const file = await screensaver.convert(id);
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable' });
        return res.end(await readFile(file));
      }
      if (req.method === 'GET' && path === '/api/history') return json(res, 200, await dashboard.history(url.searchParams.get('period') || 'day'));
      if (req.method === 'GET' && /^\/api\/(camera|artwork)\//.test(path)) {
        const [, , kind, encoded] = path.split('/'), id = decodeURIComponent(encoded);
        let upstream;
        if (kind === 'camera' && config.cameras.some(c => c.entity === id)) upstream = `/api/camera_proxy/${encodeURIComponent(id)}?time=${Date.now()}-${randomUUID()}`;
        if (kind === 'artwork' && config.speakers.some(c => c.entity === id)) {
          const picture = ha.states.get(id)?.attributes.entity_picture;
          if (typeof picture === 'string' && picture.startsWith('/api/') && !picture.startsWith('//')) upstream = picture;
        }
        if (!upstream || !ha.base) return json(res, 404, { error: 'Beeld niet beschikbaar' });
        const r = await fetch(new URL(upstream, ha.base), { cache: 'no-store', headers: { Authorization: `Bearer ${ha.token}`, 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(10000), redirect: 'error' });
        if (!r.ok || !/^image\/(jpeg|png|webp)(;|$)/i.test(r.headers.get('content-type') || '')) return json(res, 502, { error: 'Beeld niet beschikbaar' });
        const bytes = await r.arrayBuffer(); if (bytes.byteLength > 12000000) throw new Error('Beeld te groot');
        res.writeHead(200, { 'Content-Type': r.headers.get('content-type'), 'Cache-Control': 'no-store' }); return res.end(Buffer.from(bytes));
      }
      if (req.method === 'POST' && path.startsWith('/api/')) {
        // Only same-origin JSON requests from this UI; never expose a generic HA proxy.
        if (!req.headers['content-type']?.startsWith('application/json') || req.headers['x-dashboard-request'] !== '1' || (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host)) return json(res, 403, { error: 'Aanvraag niet toegestaan' });
        const data = await body(req);
        if (path === '/api/action') {
          const { entity, action, value } = data, s = houseState(ha, config, entity), domain = entity?.split('.')[0];
          if (!allowedIds().has(entity) || !available(s) || !ha.connected) return json(res, 409, { error: 'Apparaat is niet beschikbaar voor bediening' });
          const group = config.house?.lightGroups?.find(g => g.id === entity);
          let service, payload = { entity_id: group ? group.entities : entity };
          if (domain === 'light' && ['on', 'off', 'brightness', 'color'].includes(action)) {
            service = action === 'off' ? 'turn_off' : 'turn_on';
            if (action === 'brightness') { if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error('Ongeldige dimwaarde'); payload.brightness_pct = value; }
          }
          if (domain === 'light' && action === 'color') {
            if (!/^#[0-9a-f]{6}$/i.test(value) || !s.attributes.supported_color_modes?.some(m => ['xy', 'hs', 'rgb', 'rgbw', 'rgbww'].includes(m))) throw new Error('Ongeldige kleur');
            payload.rgb_color = [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16));
          }
          if (domain === 'switch' && ['on', 'off'].includes(action)) service = action === 'on' ? 'turn_on' : 'turn_off';
          if (domain === 'scene' && action === 'activate') service = 'turn_on';
          if (domain === 'media_player' && config.speakers.some(p => p.entity === entity)) {
            service = { play: 'media_play', pause: 'media_pause', next: 'media_next_track', previous: 'media_previous_track', volume: 'volume_set' }[action];
            if (action === 'volume') { if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('Ongeldig volume'); payload.volume_level = value; }
          }
          if (group && service === 'turn_on') {
            if (action !== 'brightness' && Number.isFinite(s.attributes.brightness)) payload.brightness = s.attributes.brightness;
            if (action !== 'color') {
              const a = s.attributes;
              if (a.color_mode === 'color_temp' && Number.isFinite(a.color_temp_kelvin)) payload.color_temp_kelvin = a.color_temp_kelvin;
              else if (a.rgb_color) payload.rgb_color = a.rgb_color;
              else if (a.xy_color) payload.xy_color = a.xy_color;
            }
          }
          if (!service) return json(res, 400, { error: 'Bediening wordt niet ondersteund' });
          await ha.service(domain, service, payload); await ha.refresh();
          return json(res, 200, { accepted: true });
        }
        if (path === '/api/music/queue') {
          if (!config.speakers.some(s => s.entity === data.entity) || !ha.hasService('music_assistant', 'get_queue')) return json(res, 501, { error: 'Wachtrij is niet beschikbaar voor deze speaker' });
          const r = await ha.service('music_assistant', 'get_queue', { entity_id: data.entity }, true);
          const queue = r.service_response?.[data.entity];
          if (!queue) throw new Error('Ongeldige wachtrijresponse');
          return json(res, 200, { count: queue.items, current: queue.current_item?.name || null, next: queue.next_item?.name || null, shuffle: queue.shuffle_enabled, repeat: queue.repeat_mode });
        }
        if (path === '/api/music/search' || path === '/api/music/library') {
          const service = path.endsWith('search') ? 'search' : 'get_library', entry = config.musicAssistantEntryId || ha.musicEntry(config.speakers);
          if (!entry || !ha.hasService('music_assistant', service)) return json(res, 501, { error: 'Deze Music Assistant-functie is niet beschikbaar via Home Assistant' });
          if (service === 'get_library' && libraryCache && Date.now() - libraryCache.at < 1800000) return json(res, 200, libraryCache.items);
          const payload = { config_entry_id: entry, limit: 12 };
          if (service === 'search') { if (typeof data.query !== 'string' || !data.query.trim() || data.query.length > 160) throw new Error('Vul een zoekterm in'); payload.name = data.query; }
          else { payload.media_type = 'playlist'; payload.favorite = true; }
          const r = await ha.service('music_assistant', service, payload, true);
          // Project only display fields, never raw service payloads.
          const response = r.service_response || {}, rows = Array.isArray(response.items) ? response.items : Object.values(response).filter(Array.isArray).flat();
          const items = rows.filter(i => i.uri && i.name).map(i => {
            let image = null;
            try { const u = new URL(i.image); if (u.protocol === 'https:' && u.hostname.endsWith('.mzstatic.com')) image = u.href; } catch {}
            return { uri: i.uri, name: i.name, type: i.media_type, provider: musicSource(i), image, artist: (i.artists || []).map(a => a.name).join(', ') };
          });
          for (const i of items) mediaItems.set(i.uri, i);
          if (mediaItems.size > 500) { const keep = items; mediaItems.clear(); for (const i of keep) mediaItems.set(i.uri, i); }
          if (service === 'get_library') libraryCache = { at: Date.now(), items };
          return json(res, 200, items);
        }
        if (path === '/api/music/play') {
          if (!config.speakers.some(s => s.entity === data.entity) || !mediaItems.has(data.uri) || !available(ha.states.get(data.entity)) || !ha.connected || !ha.hasService('music_assistant', 'play_media')) return json(res, 409, { error: 'Kies een beschikbaar muziekresultaat en een online speaker' });
          const item = mediaItems.get(data.uri);
          await ha.service('music_assistant', 'play_media', { entity_id: data.entity, media_id: item.uri, media_type: item.type, enqueue: 'replace' });
          return json(res, 200, { accepted: true });
        }
      }
      if (req.method !== 'GET') return json(res, 404, { error: 'Niet gevonden' });
      const file = resolve(root, '.' + decodeURIComponent(path === '/' ? '/index.html' : path));
      if (!file.startsWith(root + '/') || !(await stat(file).catch(() => null))?.isFile()) return json(res, 404, { error: 'Niet gevonden' });
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };
      res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); res.end(await readFile(file));
    } catch (e) {
      // Never log request URLs, upstream response bodies or tokens.
      json(res, e.statusCode || 502, { error: e.publicMessage || (e.message?.startsWith('Bron geeft HTTP') ? e.message : 'Aanvraag mislukt. Controleer de koppeling of configuratie.') });
    }
  });
  const mediaItems = new Map();
  let libraryCache;
  const timers = [];
  return { server, ha, waste, weather, dashboard,
    start() {
      ha.start(); waste.start().catch(() => {});
      const update = () => Promise.allSettled([dashboard.refreshCalendar(), dashboard.refreshDaily()]);
      ha.refresh().then(update).catch(() => {});
      weather.refresh().catch(() => {});
      timers.push(setInterval(update, 300000), setInterval(() => weather.refresh(), 1800000));
    },
    stop() { timers.forEach(clearInterval); ha.stop(); waste.stop(); server.close(); }
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = await createApp(); app.start();
  app.server.listen(Number(process.env.PORT || 8080), '0.0.0.0', () => console.log('Dashboard luistert op poort ' + (process.env.PORT || 8080)));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { app.stop(); });
}
