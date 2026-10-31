import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAddress, selectAddress, normalizeWaste, WasteCalendar } from '../server/waste.js';
import { localDate, midnight, namesIn, power } from '../server/utils.js';
import { HomeAssistant } from '../server/ha.js';
import { createApp } from '../server/index.js';
import { Dashboard } from '../server/dashboard.js';
import { meterTotal } from '../server/dashboard.js';
import { powerColumns } from '../server/history.js';
import { musicSource } from '../server/music.js';

test('Nederlandse kalenderdatums en zomertijd behouden de juiste dag', () => {
  assert.equal(localDate(new Date('2026-10-31T23:30:00Z')), '2026-11-01');
  assert.equal(midnight('2026-03-29'), '2026-03-28T23:00:00.000Z');
  assert.equal(midnight('2026-03-30'), '2026-03-29T22:00:00.000Z');
  assert.equal(midnight('2026-10-25'), '2026-10-24T22:00:00.000Z');
  assert.equal(midnight('2026-10-26'), '2026-10-25T23:00:00.000Z');
});
test('namen zijn hele woorden, meerdere namen blijven los herkenbaar', () => {
  const names = ['Alex', 'Robin', 'Sam'];
  assert.deepEqual(namesIn('Afspraak ALEX, Robin en Sam', names), names);
  assert.deepEqual(namesIn('Vakantie · Alexs afspraak · Robina', names), []);
});
test('vermogen onderscheidt nul, ontbrekende waarde en eenheid', () => {
  assert.equal(power({ state: '0', attributes: { unit_of_measurement: 'W' } }), 0);
  assert.equal(power({ state: '1.3', attributes: { unit_of_measurement: 'kW' } }), 1300);
  assert.equal(power({ state: 'unavailable', attributes: {} }), null);
  assert.equal(power({ state: '22', attributes: { unit_of_measurement: 'kWh' } }), null);
});
test('afvaladres wordt exact geselecteerd, inclusief voorloopnullen en toevoeging', () => {
  const address = parseAddress(' 1234 zz : 99 ');
  assert.equal(address.id, '1234ZZ:99');
  const rows = [{ postcode: '1234ZZ', huisnummer: 99, bagid: '999999999999999999' }];
  assert.equal(selectAddress(rows, address), '999999999999999999');
  assert.throws(() => selectAddress([...rows, ...rows], address), /eenduidig/);
  assert.throws(() => parseAddress('https://example.org'), /AFVALKALENDER_ADRESS/);
});
const types = [{ id: 1, title: 'Rest' }, { id: 2, title: 'Gft & etensresten' }, { id: 3, title: 'Papier en karton' }, { id: 4, title: 'Artikel zonder datum' }];
const records = [{ afvalstroom_id: 1, ophaaldatum: '2026-11-03' }, { afvalstroom_id: 2, ophaaldatum: '2026-11-10' }, { afvalstroom_id: 3, ophaaldatum: '2026-11-18' }];
test('afvalnormalisatie behoudt meerdere soorten op één dag en verwijdert duplicaten', () => {
  const result = normalizeWaste([...records, records[0], { afvalstroom_id: 2, ophaaldatum: '2026-11-03' }], types);
  assert.equal(result.length, 4);
  assert.equal(result.filter(r => r.date === '2026-11-03').length, 2);
  assert.ok(!result.some(r => r.title.includes('Artikel')));
  assert.throws(() => normalizeWaste([{ afvalstroom_id: 9, ophaaldatum: '2026-11-01' }], types));
  assert.throws(() => normalizeWaste([{ afvalstroom_id: 1, ophaaldatum: '2026-02-30' }], types));
});
test('afvalcache overleeft offline herstart en meldt ontbrekende jaardekking', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dashboard-waste-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let calls = 0, now = new Date('2026-10-31T13:00:00Z');
  const get = async url => {
    calls++;
    if (url.includes('/adressen/1234')) return [{ postcode: '1234ZZ', huisnummer: 99, bagid: '999999999999999999' }];
    if (url.endsWith('/afvalstromen')) return types;
    if (url.endsWith('/2027')) throw new Error('Nog niet gepubliceerd');
    return records;
  };
  const waste = new WasteCalendar('1234ZZ:99', dir, get, () => now);
  await waste.start(); waste.stop();
  assert.equal(waste.view().records.length, 3);
  assert.deepEqual(waste.view().missingYears, [2027]);
  assert.equal(calls, 5);
  assert.ok((await readFile(join(dir, 'waste.json'), 'utf8')).includes('lastSuccessAt'));
  const restarted = new WasteCalendar('1234ZZ:99', dir, async () => { throw new Error('Deze request mag niet plaatsvinden'); }, () => now);
  await restarted.start(); restarted.stop();
  assert.equal(restarted.view().error, null);
  now = new Date('2026-11-03T13:00:00Z');
  await restarted.tick();
  assert.equal(restarted.view().stale, true);
  assert.equal(restarted.view().records.length, 3); // Vandaag blijft zichtbaar.
  now = new Date('2026-11-04T13:00:00Z');
  assert.equal(restarted.view().records.length, 2);
  const changed = new WasteCalendar('1234ZZ:98', dir, async () => { throw new Error('Offline'); }, () => now);
  await changed.start(); changed.stop();
  assert.equal(changed.view().records.length, 0); // Geen cache van een ander adres.
});
test('gebieden volgen entity- en device-registry; infrastructuur-LEDs worden weggelaten', () => {
  const ha = new HomeAssistant('http://example.org/lovelace/default_view', 'secret');
  assert.equal(ha.base, 'http://example.org');
  ha.areas = [{ area_id: 'woonkamer', name: 'Woonkamer' }];
  ha.devices = [{ id: 'device', area_id: 'woonkamer' }];
  ha.entities = [{ entity_id: 'light.lamp', device_id: 'device' }, { entity_id: 'light.router_led', device_id: 'device' }, { entity_id: 'light.disabled', area_id: 'woonkamer', disabled_by: 'user' }];
  assert.deepEqual(ha.rooms()[0].entities, ['light.lamp']);
});
const config = { location: 'Home', calendar: 'calendar.example', indoorTemperature: null, weather: null, quickActions: [{ name: 'Lamp', entities: ['light.test'] }], speakers: [{ name: 'Speaker', entity: 'media_player.test' }], cameras: [], energy: { solar: 'sensor.solar', grid: 'sensor.grid', gridPositiveIsImport: true, deriveHome: false, consumers: [] } };
test('HTTP-grens beschermt geheimen, bestanden en apparaatbediening', async t => {
  const calls = [], ha = new HomeAssistant('http://example.org', 'SECRET_MUST_NOT_LEAK');
  ha.connected = true; ha.lastSuccessAt = new Date().toISOString();
  ha.states.set('light.test', { entity_id: 'light.test', state: 'off', attributes: { friendly_name: '<Lamp>', access_token: 'NEVER_PUBLIC' } });
  ha.service = async (...args) => { calls.push(args); }; ha.refresh = async () => {};
  const app = await createApp({ env: {}, config, ha });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r)); t.after(() => app.stop());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await fetch(`${base}/health`)).status, 200);
  const text = await (await fetch(`${base}/api/dashboard`)).text();
  assert.ok(!text.includes('SECRET_MUST_NOT_LEAK') && !text.includes('NEVER_PUBLIC'));
  const post = (data, headers = {}) => fetch(`${base}/api/action`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dashboard-Request': '1', ...headers }, body: JSON.stringify(data) });
  assert.equal((await post({ entity: 'switch.fridge', action: 'off' })).status, 409);
  assert.equal((await post({ entity: 'light.test', action: 'on' }, { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await fetch(`${base}/api/action`, { method: 'POST', body: '{}' })).status, 403);
  assert.equal(calls.length, 0);
  assert.equal((await post({ entity: 'light.test', action: 'on' })).status, 200);
  assert.deepEqual(calls[0], ['light', 'turn_on', { entity_id: 'light.test' }]);
  assert.equal((await post({ entity: 'light.test', action: 'brightness', value: 200 })).status, 502);
  assert.equal((await fetch(`${base}/.env`)).status, 404);
  assert.equal((await fetch(`${base}/server/index.js`)).status, 404);
  ha.connected = false;
  assert.equal((await post({ entity: 'light.test', action: 'off' })).status, 409);
});
test('ontbrekend huisverbruik wordt niet afgeleid zonder bevestigde tekenconventie', () => {
  const ha = new HomeAssistant(null, null);
  for (const [id, value] of [['sensor.solar', 1000], ['sensor.grid', -600]]) ha.states.set(id, { entity_id: id, state: String(value), attributes: { unit_of_measurement: 'W' } });
  const d = new Dashboard(ha, structuredClone(config)), stub = { view: () => ({}) };
  assert.equal(d.view(stub, stub).energy.home, null);
  d.config.energy.deriveHome = true;
  assert.equal(d.view(stub, stub).energy.home, 400);
});
test('teruglopende energieteller geeft een diagnose en geen misleidend dagtotaal', async () => {
  const ha = new HomeAssistant(null, null), day = localDate(), start = midnight(day);
  const sample = value => ({ entity_id: 'sensor.solar_meter', state: String(value), last_changed: start, attributes: { unit_of_measurement: 'Wh' } });
  ha.states.set('sensor.solar_meter', sample(1460));
  ha.request = async () => [[sample(1000), sample('unavailable'), sample(1464), sample(1460)]];
  const c = structuredClone(config); c.energy.solarMeter = 'sensor.solar_meter';
  const d = new Dashboard(ha, c); await d.refreshDaily();
  assert.equal(d.daily.solar, undefined);
  assert.match(d.daily.warnings[0], /teller liep terug/);
  ha.request = async () => [[sample(1000), sample('unavailable'), sample(1460)]];
  await d.refreshDaily();
  assert.equal(d.daily.solar.value, 0.46);
  assert.deepEqual(d.daily.warnings, []);
});
test('SolarEdge-afronding mag binnen ingestelde marge teruglopen, een reset niet', () => {
  const start = midnight(localDate());
  const row = n => ({ state: String(n), last_changed: start });
  assert.equal(meterTotal([row(1000), row(1464), row(1460)], row(1460), start, 10), 460);
  assert.equal(meterTotal([row(1000), row(1464), row(1460)], row(1460), start, 0), null);
  assert.equal(meterTotal([row(1000), row(1464), row(1400)], row(1460), start, 10), null);
  // Do not let repeated small decreases hide a large fall from the high-water mark.
  assert.equal(meterTotal([row(1000), row(1464), row(1457), row(1450)], row(1450), start, 10), null);
  assert.equal(meterTotal([], row(1460), start, 10), null);
});
test('kolommen wegen tijd, behouden negatief vermogen en slaan onbekende intervallen over', () => {
  const row = (time, state) => ({ last_changed: `2026-10-31T${time}:00Z`, state: String(state), attributes: { unit_of_measurement: 'W' } });
  const result = powerColumns([row('10:00', 100), row('10:15', 500), row('11:00', 'unavailable'), row('12:00', -200)], '2026-10-31T10:00:00Z', '2026-10-31T13:00:00Z', 'day');
  assert.equal(result.length, 2);
  assert.equal(result[0].value, 400);
  assert.equal(result[0].seconds, 3600);
  assert.equal(result[1].value, -200);
});
test('dagkolommen respecteren de 25 uur bij de wintertijdovergang', () => {
  const start = midnight('2026-10-25'), end = midnight('2026-10-26');
  const rows = [{ state: '100', last_changed: start, attributes: { unit_of_measurement: 'W' } }];
  const result = powerColumns(rows, start, end, 'week');
  assert.equal(result.length, 1);
  assert.equal(result[0].seconds, 25 * 3600);
});
test('muziekbron onderscheidt Apple, lokale bestanden en onbekende bibliotheekitems', () => {
  assert.equal(musicSource({ uri: 'apple_music--instance://track/1' }), 'Apple Music');
  assert.equal(musicSource({ uri: 'library://track/1', image: 'http://example.test/imageproxy?provider=filesystem_local--instance' }), 'Lokale bibliotheek');
  assert.equal(musicSource({ uri: 'library://playlist/1', image: 'https://is1-ssl.mzstatic.com/cover.png' }), 'Music Assistant-bibliotheek');
  assert.equal(musicSource({ uri: 'library://artist/1' }), 'Music Assistant-bibliotheek');
});
test('cameraproxy vraagt iedere keer een ongecachet upstreambeeld op', async t => {
  const ha = new HomeAssistant('http://camera-upstream.test', 'private-token');
  const c = structuredClone(config); c.cameras = [{ name: 'Hoofdbeeld', entity: 'camera.test' }];
  const upstream = [], originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('http://camera-upstream.test/')) {
      upstream.push({ url: String(url), options });
      return new Response(new Uint8Array([1, 2, upstream.length]), { headers: { 'Content-Type': 'image/jpeg' } });
    }
    return originalFetch(url, options);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const app = await createApp({ env: {}, config: c, ha });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); t.after(() => app.stop());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  for (let i = 0; i < 2; i++) {
    const response = await originalFetch(`${base}/api/camera/camera.test`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(new Uint8Array(await response.arrayBuffer())[2], i + 1);
  }
  assert.notEqual(upstream[0].url, upstream[1].url);
  assert.equal(upstream[0].options.cache, 'no-store');
  assert.equal(upstream[0].options.headers['Cache-Control'], 'no-cache');
  assert.ok(!upstream[0].url.includes('private-token'));
});
test('offline SolarEdge-teller behoudt laatste dagopwek en markeert afgeleid dagverbruik', async () => {
  const ha = new HomeAssistant(null, null), start = midnight(localDate());
  const c = structuredClone(config);
  Object.assign(c.energy, { solarMeter: 'sensor.solar_meter', importMeter: 'sensor.import', exportMeter: 'sensor.export', deriveHome: true, solarMeterDecreaseToleranceWh: 10 });
  const row = (id, value, unit = 'kWh', time = start) => ({ entity_id: id, state: String(value), last_changed: time, last_updated: time, attributes: { unit_of_measurement: unit } });
  const last = new Date(Date.parse(start) + 12 * 3600000).toISOString();
  const solar = [row('sensor.solar_meter', 1000, 'Wh'), row('sensor.solar_meter', 1464, 'Wh', last), row('sensor.solar_meter', 1460, 'Wh', last), row('sensor.solar_meter', 'unavailable', 'Wh', last)];
  ha.states.set('sensor.solar_meter', solar.at(-1));
  ha.states.set('sensor.import', row('sensor.import', 8));
  ha.states.set('sensor.export', row('sensor.export', 2));
  ha.request = async () => [solar, [row('sensor.import', 5)], [row('sensor.export', 1)]];
  const d = new Dashboard(ha, c), stub = { view: () => ({}) };
  await d.refreshDaily();
  assert.equal(d.daily.solar.value, .46);
  assert.equal(d.daily.solar.stale, true);
  assert.match(d.daily.warnings[0], /Opwekbron offline/);
  assert.ok(!d.daily.warnings.some(w => w.includes('teller liep terug')));
  const view = d.view(stub, stub);
  assert.ok(Math.abs(view.energy.daily.home.value - 2.46) < 1e-8);
  assert.equal(view.energy.daily.home.stale, true);
  assert.equal(view.energy.home, null); // Unknown live solar power must not turn into zero.
  assert.equal(d.daily.home, undefined); // Reading the snapshot must not mutate the source cache.
  ha.states.set('sensor.solar_meter', row('sensor.solar_meter', 1600, 'Wh', last));
  await d.refreshDaily();
  assert.equal(d.daily.solar.value, .6);
  assert.equal(d.daily.solar.stale, false);
  assert.equal(d.view(stub, stub).energy.daily.home.stale, false);
  assert.deepEqual(d.daily.warnings, []);
});
test('zonder geldige dagbeginstand worden oude tellerwaarden geen dagopwek', async () => {
  const ha = new HomeAssistant(null, null), start = midnight(localDate());
  const c = structuredClone(config); c.energy.solarMeter = 'sensor.solar_meter';
  const row = state => ({ entity_id: 'sensor.solar_meter', state, last_changed: start, attributes: { unit_of_measurement: 'Wh' } });
  ha.states.set('sensor.solar_meter', row('unavailable'));
  ha.request = async () => [[row('unavailable'), { ...row('1600'), last_changed: new Date(Date.parse(start) + 3600000).toISOString() }]];
  const d = new Dashboard(ha, c); await d.refreshDaily();
  assert.equal(d.daily.solar, undefined);
});
test('zonnestroom, direct verbruik en totaal huisverbruik blijven onderscheiden', () => {
  const cases = [
    { solar: 1200, grid: -400, direct: 800, home: 800 },
    { solar: 1200, grid: 300, direct: 1200, home: 1500 },
    { solar: 0, grid: 500, direct: 0, home: 500 },
    { solar: null, grid: 500, direct: 0, home: 500 },
    { solar: 1200, grid: null, direct: null, home: null }
  ];
  for (const sample of cases) {
    const ha = new HomeAssistant(null, null), c = structuredClone(config);
    Object.assign(c.energy, { deriveHome: true, assumeMissingSolarZero: true });
    for (const [id, n] of [['sensor.solar', sample.solar], ['sensor.grid', sample.grid]]) ha.states.set(id, { entity_id: id, state: n === null ? 'unavailable' : String(n), attributes: { unit_of_measurement: 'W' } });
    const d = new Dashboard(ha, c), stub = { view: () => ({}) }, e = d.view(stub, stub).energy;
    assert.equal(e.directConsumption, sample.direct);
    assert.equal(e.home, sample.home);
    assert.equal(e.solarAssumedZero, sample.solar === null);
  }
});
test('dagkaarten trekken de middernachtstand af van cumulatieve meters', async () => {
  const ha = new HomeAssistant(null, null), c = structuredClone(config), start = midnight(localDate());
  Object.assign(c.energy, { solarMeter: 'sensor.solar_meter', importMeter: 'sensor.import', exportMeter: 'sensor.export', deriveHome: true });
  const row = (id, value, unit) => ({ entity_id: id, state: String(value), last_changed: start, attributes: { unit_of_measurement: unit } });
  const readings = [
    ['sensor.solar_meter', 30335196, 30339856, 'Wh'],
    ['sensor.import', 15827.249, 15839.357, 'kWh'],
    ['sensor.export', 13106.267, 13107.115, 'kWh']
  ];
  for (const [id, , end, unit] of readings) ha.states.set(id, row(id, end, unit));
  ha.request = async () => readings.map(([id, first, last, unit]) => [row(id, first, unit), row(id, last, unit)]);
  const d = new Dashboard(ha, c); await d.refreshDaily();
  const stub = { view: () => ({}) }, daily = d.view(stub, stub).energy.daily;
  assert.ok(Math.abs(daily.import.value - 12.108) < 1e-8);
  assert.ok(Math.abs(daily.home.value - 15.92) < 1e-8);
  assert.equal(daily.import.startReading, 15827.249);
  assert.equal(daily.import.endReading, 15839.357);
  assert.equal(daily.periodStart, start);
  assert.equal(daily.solar.value, 4.66);
  assert.ok(daily.import.value < daily.import.endReading);
});
