import { isUpcoming } from './calendar.js';

const $ = selector => document.querySelector(selector);
const titles = ['Je energie in beeld', 'Een fijn huis', 'Welkom thuis', 'Tijd voor muziek', 'Een blik naar buiten'];
const pages = ['Energie', 'Huis', 'Vandaag', 'Muziek', 'Camera’s'], icons = ['↯', '⌂', '◷', '♫', '▣'];
const tz = 'Europe/Amsterdam';
let page = 2, state, speaker, busy = false, dialogMode = null, selectedRoom, cameraTimer;
let lastRenderedPage = -1;
let favorites = null, favoriteRequest = false;
const pendingVolumes = new Map();
let volumeEditing = false;
function volumePercent(id = speaker) {
  const actual = Math.round(Math.max(0, Math.min(1, Number(entity(id)?.volume) || 0)) * 100);
  const pending = pendingVolumes.get(id);
  if (!pending) return actual;
  if (Math.abs(actual - pending.value) <= 1) { pendingVolumes.delete(id); return actual; }
  if (Date.now() >= pending.until) { pendingVolumes.delete(id); toast('Volume niet bevestigd; het actuele speakervolume wordt getoond.'); return actual; }
  return pending.value;
}
function syncVolume() {
  const input = $('[data-volume]'); if (!input || volumeEditing) return;
  const value = volumePercent(); input.value = value;
  if ($('[data-volume-value]')) $('[data-volume-value]').textContent = `${value}%`;
  if ($('[data-volume-status]')) $('[data-volume-status]').textContent = pendingVolumes.has(speaker) ? 'Wachten op de speaker…' : '';
}
function setVolume(input) {
  const id = speaker, value = Number(input.value);
  volumeEditing = false;
  pendingVolumes.set(id, { value, until: Date.now() + 15000 });
  syncVolume();
  perform(async () => {
    try { await api('/api/action', { entity: id, action: 'volume', value: value / 100 }); }
    catch (error) { pendingVolumes.delete(id); throw error; }
  }, 'Volumeopdracht verstuurd');
}
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (n, unit = '', digits = 1) => n === null || n === undefined || !Number.isFinite(n) ? 'Niet beschikbaar' : `${new Intl.NumberFormat('nl-NL', { maximumFractionDigits: digits }).format(n)}${unit ? ` ${esc(unit)}` : ''}`;
const watts = n => n === null || n === undefined ? 'Niet beschikbaar' : Math.abs(n) >= 1000 ? fmt(Math.abs(n) / 1000, 'kW', 2) : fmt(Math.abs(n), 'W', 0);
const dayOf = date => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(date));
const dayLabel = day => {
  const today = dayOf(new Date()), tomorrow = new Date(Date.parse(`${today}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
  return day === today ? 'Vandaag' : day === tomorrow ? 'Morgen' : new Intl.DateTimeFormat('nl-NL', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${day}T12:00:00Z`));
};
const time = date => new Intl.DateTimeFormat('nl-NL', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(new Date(date));
const entity = id => state?.entities[id];
const offline = id => !entity(id)?.available || state.connection.stale || !state.connection.live;
const empty = text => `<div class="empty">${esc(text)}</div>`;
const updated = date => date ? `Bijgewerkt ${time(date)}` : 'Nog niet opgehaald';
const agendaColors = ['blue', 'pink', 'red', 'orange'];
function agendaColor(name) {
  const index = state.calendarNames?.indexOf(name) ?? -1;
  if (index >= 0) return agendaColors[index % agendaColors.length];
  let hash = 0;
  for (const char of String(name).toLocaleLowerCase()) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return agendaColors[hash % agendaColors.length];
}
async function api(path, body) {
  const r = await fetch(path, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dashboard-Request': '1' }, body: JSON.stringify(body) });
  const json = await r.json(); if (!r.ok) throw new Error(json.error || 'Verbinding mislukt'); return json;
}
function toast(text) { $('#toast').textContent = text; $('#toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => $('#toast').hidden = true, 4000); }
function modal(title, html, mode = null) { releaseCameras($('#dialog-body')); dialogMode = mode; $('#dialog-title').textContent = title; $('#dialog-body').innerHTML = html; if (!$('dialog').open) $('dialog').showModal(); }
function actionButton(action, index) {
  const scene = action.entities[0]?.startsWith('scene.'), on = action.entities.some(id => entity(id)?.state === 'on');
  return `<button class="action ${on ? 'on' : ''}" data-quick="${index}" ${busy || action.entities.some(offline) ? 'disabled' : ''}><b>${scene ? '✧' : '☼'} ${esc(action.name)}</b><small>${action.entities.some(offline) ? 'Niet beschikbaar' : scene ? 'Scène uitvoeren' : action.action === 'off' ? 'Alles uitzetten' : on ? 'Aan · tik om uit te zetten' : 'Uit · tik om aan te zetten'}</small></button>`;
}
function playerControls(compact = false) {
  const s = entity(speaker), disabled = offline(speaker) || busy;
  return `<div class="${compact ? 'mini' : 'player'}">${compact ? artwork(s, 'art') : ''}${compact ? `<button class="mini-track" data-page="3" aria-label="Open muziek"><b>${esc(s?.title || 'Geen muziek')}</b><small>${esc(state.speakers.find(p => p.entity === speaker)?.name || 'Speaker')} · ${esc(s?.artist || s?.state || 'Niet beschikbaar')} →</small></button>` : ''}<div class="controls">${!compact ? `<button data-media="previous" aria-label="Vorig nummer" ${disabled || !(s?.features & 16) ? 'disabled' : ''}>‹</button>` : ''}<button class="${compact ? '' : 'play'}" data-media="${s?.state === 'playing' ? 'pause' : 'play'}" aria-label="${s?.state === 'playing' ? 'Pauzeren' : 'Afspelen'}" ${disabled || !(s?.features & (s?.state === 'playing' ? 1 : 16384)) ? 'disabled' : ''}>${s?.state === 'playing' ? 'Ⅱ' : '▶'}</button>${!compact ? `<button data-media="next" aria-label="Volgend nummer" ${disabled || !(s?.features & 32) ? 'disabled' : ''}>›</button>` : ''}</div></div>`;
}
function artwork(s, className) { return s?.artwork ? `<img class="${className}" src="${esc(s.artwork)}" alt="Albumhoes">` : `<div class="${className}" aria-hidden="true">♫</div>`; }
function agenda(limit) {
  const now = new Date();
  const events = state.calendar.events.map((event, index) => ({ event, index })).filter(({ event }) => isUpcoming(event, now));
  if (!events.length) return empty(state.calendar.error || 'Geen komende afspraken. Even tijd voor elkaar.');
  let lastDay;
  return events.slice(0, limit).map(({ event: e, index: i }) => {
    const day = e.allDay ? e.start : dayOf(e.start), heading = day !== lastDay ? `<div class="day">${esc(dayLabel(day))}</div>` : ''; lastDay = day;
    const names = e.names || [], color = names.length === 1 ? agendaColor(names[0]) : '';
    return `${heading}<button class="event ${color}" data-event="${i}"><time>${e.allDay ? 'Hele dag' : time(e.start)}</time><div><b>${esc(e.title)}</b><p>${esc(e.location || (e.allDay ? 'Dagevenement' : e.end ? `Tot ${time(e.end)}` : ''))}</p>${names.length > 1 ? names.map(n => `<span class="badge ${agendaColor(n)}">${esc(n)}</span>`).join('') : ''}</div></button>`;
  }).join('');
}
function forecastCondition(day) {
  if (day.condition) return { icon: ({ sunny: '☀', cloudy: '☁', partlycloudy: '⛅', rainy: '☂', snowy: '❄' })[day.condition] || '☁', label: ({ sunny: 'Zonnig', cloudy: 'Bewolkt', partlycloudy: 'Half bewolkt', rainy: 'Regen', snowy: 'Sneeuw', 'clear-night': 'Helder' })[day.condition] || day.condition };
  const code = day.code;
  return code === 0 ? { icon: '☀', label: 'Zonnig' } : code <= 2 ? { icon: '⛅', label: 'Half bewolkt' } : code === 3 ? { icon: '☁', label: 'Bewolkt' } : code <= 48 ? { icon: '≋', label: 'Mist' } : code >= 95 ? { icon: 'ϟ', label: 'Onweer' } : code >= 71 && code <= 77 || code >= 85 && code <= 86 ? { icon: '❄', label: 'Sneeuw' } : { icon: '☂', label: 'Regen of motregen' };
}
function weatherArt(day) {
  const kind = forecastCondition(day), sunny = kind.icon === '☀', mixed = kind.icon === '⛅', rain = kind.icon === '☂', snow = kind.icon === '❄', storm = kind.icon === 'ϟ';
  const sun = '<circle cx="37" cy="33" r="16" fill="#f5bd43"/><g stroke="#e6a82d" stroke-width="4" stroke-linecap="round"><path d="M37 7v5M37 54v5M11 33h5M58 33h5M19 15l4 4M51 47l4 4M19 51l4-4M51 19l4-4"/></g>';
  const cloud = '<path d="M25 64C8 64 7 42 23 39 23 17 55 13 65 34 86 28 96 60 75 64Z" fill="#a8c1cf"/><path d="M25 59C14 59 13 45 27 44 26 26 52 22 61 41 78 33 90 56 74 59Z" fill="#e4eef2"/>';
  const drops = '<g stroke="#559dcd" stroke-width="4" stroke-linecap="round"><path d="M31 73l-5 9M50 73l-5 9M69 73l-5 9"/></g>';
  return `<svg class="weather-art ${sunny ? 'sunny' : rain || storm ? 'rainy' : 'cloudy'}" viewBox="0 0 100 90" role="img" aria-label="${esc(kind.label)}">${sunny || mixed ? sun : ''}${sunny ? '' : cloud}${rain ? drops : ''}${snow ? '<g fill="#7caec6"><circle cx="30" cy="77" r="3"/><circle cx="50" cy="81" r="3"/><circle cx="70" cy="77" r="3"/></g>' : ''}${storm ? '<path d="M49 65l-8 14h9l-5 10 17-17H51l6-7Z" fill="#edba45"/>' : ''}</svg>`;
}
function weatherView() {
  const w = state.weather;
  if (!w.current) return empty(w.error || 'Weer wordt opgehaald…');
  const code = w.current.code, condition = w.current.condition;
  const icon = condition ? ({ sunny: '☀', 'partlycloudy': '⛅', cloudy: '☁', rainy: '☂' }[condition] || '☁') : code <= 1 ? '☀' : code <= 3 ? '☁' : code >= 51 ? '☂' : '≋';
  const description = condition ? ({ sunny: 'Zonnig', partlycloudy: 'Half bewolkt', cloudy: 'Bewolkt', rainy: 'Regenachtig', clear: 'Helder', 'clear-night': 'Heldere nacht' }[condition] || condition) : code <= 1 ? 'Helder' : code <= 3 ? 'Bewolkt' : code >= 51 ? 'Neerslag' : 'Mistig';
  const rain = w.hourly?.find(h => h.rain > 0);
  return `<div class="weather-symbol">${weatherArt(w.current)}<span class="temp">${fmt(w.current.temperature, '°', 0)}</span></div><h3>${esc(state.location)} · ${esc(description)}</h3><p>${rain ? `Neerslag verwacht rond ${time(rain.time)} · ${fmt(rain.rain, 'mm')}` : 'Geen neerslag in de beschikbare verwachting'}</p><div class="forecast">${(w.hourly || []).slice(0, 3).map(h => `<div><small>${time(h.time)}</small><b>${fmt(h.temperature, '°', 0)}</b><small>${fmt(h.probability, '%', 0)} regen</small></div>`).join('')}</div><button class="weather-outlook" data-weather>${(w.daily || []).length ? (w.daily || []).map((d, i) => `<span class="outlook-day"><span class="outlook-label">${weatherArt(d)}<b>${i === 0 ? 'Morgen' : 'Overmorgen'}</b></span><span class="outlook-temp">${fmt(d.min, '°', 0)} / ${fmt(d.max, '°', 0)}</span></span>`).join('') : '<span>Meer weersverwachting</span>'}<span class="outlook-arrow" aria-hidden="true">→</span></button><p class="note ${w.stale ? 'error' : ''}">${esc(w.source)} · ${updated(w.lastSuccessAt)}${w.error ? ` · ${esc(w.error)}` : ''}</p>`;
}
function wasteSummary() {
  const w = state.waste, first = w.records[0];
  return first ? `${w.records.filter(r => r.date === first.date).map(r => esc(r.title)).join(' + ')} <b>${esc(dayLabel(first.date))} →</b>` : esc(w.error || 'Geen inzameling beschikbaar');
}
function todayView() {
  const limit = window.innerHeight < 780 ? 3 : 5;
  return `<div class="grid today"><article class="card"><div class="eyebrow" id="date"></div><div class="time" id="clock"></div><p>Fijn dat je thuis bent.</p>${weatherView()}</article><article class="card"><h2>De gezinsagenda</h2><div data-agenda-list="${limit}">${agenda(limit)}</div><button class="pill full" data-agenda>Alle afspraken →</button>${state.calendar.error ? `<p class="note error">${esc(state.calendar.error)} · ${updated(state.calendar.lastSuccessAt)}</p>` : ''}</article><article class="card"><h2>Even regelen</h2><div class="actions">${state.quickActions.map(actionButton).join('')}</div>${playerControls(true)}<button class="pill full" data-page="3">Open muziek →</button></article></div><div class="status">${state.temperature.value !== null ? `<span>♨ Binnentemperatuur <b>${fmt(state.temperature.value, state.temperature.unit)}</b></span>` : `<span>↔ ${state.energy.grid < 0 ? 'Teruglevering' : 'Netafname'} <b>${watts(state.energy.grid)}</b></span>`}<span>↯ Verbruik <b>${watts(state.energy.home)}</b></span><button class="waste-summary" data-waste aria-label="Open afvalkalender">♧ ${wasteSummary()}${state.waste.stale ? ' · verouderd' : ''}</button></div>`;
}
function bulbIcon() {
  return '<svg viewBox="0 0 24 24" class="bulb-icon" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 17h6M9 20h6M11 23h2M8.5 14.5a7 7 0 1 1 7 0c-1 .7-1.5 1.5-1.5 2.5h-4c0-1-.5-1.8-1.5-2.5Z"/><path d="M12 1V0M3 4 1.5 2.5M21 4l1.5-1.5"/></svg>';
}
function orderedRooms() {
  const order = ['woonkamer', 'badkamer', 'kantoor', 'terras'];
  const rank = room => { const index = order.indexOf(room.name.toLocaleLowerCase('nl')); return index < 0 ? order.length : index; };
  return [...state.rooms].sort((a, b) => rank(a) - rank(b));
}
function sceneLabel(scene, room) {
  const name = scene.name.trim(), prefix = room.name.trim();
  if (name.toLocaleLowerCase('nl').startsWith(prefix.toLocaleLowerCase('nl')) && /^[\s:–—-]/.test(name.slice(prefix.length))) {
    return name.slice(prefix.length).replace(/^[\s:–—-]+/, '') || name;
  }
  return name;
}
function roomTone(room) {
  if (/woonkamer/i.test(room.name)) return 'sage';
  if (/badkamer/i.test(room.name)) return 'blue';
  if (/kantoor/i.test(room.name)) return 'lavender';
  if (/terras|buiten|tuin/i.test(room.name)) return 'sand';
  const tones = ['sage', 'blue', 'lavender', 'sand', 'rose'];
  return tones[[...room.id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % tones.length];
}
function roomScenesView() {
  const groups = orderedRooms().map(room => ({ room, scenes: [] }));
  for (const scene of state.scenes) {
    const group = groups.find(g => g.room.entities.includes(scene.id)) || groups.find(g => scene.name.toLocaleLowerCase('nl').includes(g.room.name.toLocaleLowerCase('nl')));
    if (group) group.scenes.push(scene);
  }
  const visible = groups.filter(g => g.scenes.length);
  if (!visible.length) return '';
  return `<section class="card wide house-scenes" aria-label="Scènes per kamer"><h2>Scènes</h2><div class="scene-groups">${visible.map(({ room, scenes }) => `<section class="scene-group tone-${roomTone(room)}" aria-label="Scènes ${esc(room.name)}"><h3><span class="room-color-dot" aria-hidden="true"></span>${esc(room.name)}</h3><div class="scene-buttons">${scenes.sort((a, b) => a.name.localeCompare(b.name, 'nl')).map(scene => `<button class="scene-button" title="${esc(scene.name)}" aria-label="${esc(scene.name)}" data-scene="${esc(scene.id)}" ${!scene.available || busy || !state.connection.live ? 'disabled' : ''}><span aria-hidden="true">✧</span><span>${esc(sceneLabel(scene, room))}</span></button>`).join('')}</div></section>`).join('')}</div></section>`;
}
function roomsView() {
  return `<div class="grid rooms">${roomScenesView()}${state.rooms.length ? orderedRooms().map(r => {
    const entities = r.entities.map(entity).filter(Boolean), temps = entities.filter(e => e.deviceClass === 'temperature' && e.available), lights = entities.filter(e => /^(light|switch)\./.test(e.id));
    const lit = lights.filter(light => light.state === 'on').length;
    const glyph = /badkamer/i.test(r.name) ? '♨' : /kantoor/i.test(r.name) ? '▤' : /slaap/i.test(r.name) ? '☾' : /terras|buiten|tuin/i.test(r.name) ? '♧' : /eet|keuken/i.test(r.name) ? '☕' : '⌂';
    return `<article class="card room tone-${roomTone(r)} ${lit ? 'room-lit' : ''}" aria-label="${esc(r.name)}"><button class="room-heading" data-room="${esc(r.id)}" aria-label="Open ${esc(r.name)}"><span class="room-emblem" aria-hidden="true">${glyph}</span><span><h2>${esc(r.name)}</h2><span class="room-summary">${lit ? `${lit} ${lit === 1 ? 'apparaat aan' : 'apparaten aan'}` : lights.length ? 'Alles uit' : 'Apparaten en scènes'}${temps.length ? ` · ${esc(temps[0].state)} ${esc(temps[0].unit)}` : ''}</span></span><span class="room-arrow" aria-hidden="true">↗</span></button><div class="room-lamps">${lights.slice(0, 3).map(light => `<button class="room-lamp ${light.state === 'on' ? 'lamp-on' : ''}" data-light="${esc(light.id)}" aria-label="${esc(light.name)} ${light.state === 'on' ? 'uitzetten' : 'aanzetten'}" aria-pressed="${light.state === 'on'}" title="${esc(light.name)}" ${offline(light.id) || busy ? 'disabled' : ''}>${bulbIcon()}<span class="lamp-name">${esc(light.name)}</span><small>${offline(light.id) ? 'Offline' : light.state === 'on' ? 'Aan' : 'Uit'}</small></button>`).join('') || '<p class="note">Geen lampen in deze kamer.</p>'}</div><button class="room-more" data-room="${esc(r.id)}">${lights.length > 3 ? `Alle ${lights.length} lampen en apparaten` : 'Alle apparaten en dimmers'} <span aria-hidden="true">→</span></button></article>`;
  }).join('') : `<article class="card wide">${empty('Geen kamerindeling beschikbaar. Koppel apparaten aan gebieden in Home Assistant; de server probeert automatisch opnieuw te verbinden.')}</article>`}</div>`;
}
function energyView() {
  const e = state.energy, direction = e.grid === null ? 'Netrichting niet beschikbaar' : Math.abs(e.grid) < 10 ? 'Net · ongeveer neutraal' : e.grid > 0 ? '↓ Afname van het net' : '↑ Terug naar het net';
  return `<div class="grid energy"><article class="card energy-visual"><h2>Zo stroomt je energie</h2><div class="house"><img src="/assets/house-energy.png" alt="Illustratie van het eigen huis met zonnepanelen"><svg class="energy-path" viewBox="0 0 600 400" aria-hidden="true"><path data-energy-path="solar" class="${e.solar > 0 ? 'active' : ''}" d="M100 80 L270 150 L300 330"/><path data-energy-path="grid" class="${e.grid !== null && Math.abs(e.grid) >= 10 ? 'active' : ''} ${e.grid < 0 ? 'reverse' : ''}" d="M500 220 L400 220 L300 330"/></svg><div class="flow solar solar-summary"><b>☀ Zonnepanelen</b><div class="solar-reading"><span>Huidige opbrengst</span><strong>${watts(e.solar)}</strong></div><div class="solar-reading"><span>Direct verbruik</span><strong>${watts(e.directConsumption)}</strong></div><small class="flow-source">${e.solarAssumedZero ? 'Geen actuele opwekmeting · opwek als 0 W weergegeven' : 'Direct verbruik is zonnestroom die nu in huis wordt gebruikt.'}</small></div><div class="flow net">${direction}<b class="number">${watts(e.grid)}</b></div></div><button class="pill full" data-history="day">Bekijk historie · dag / week / maand →</button><p class="note">${e.solarAssumedZero ? 'Opwek momenteel niet gemeten: berekend met 0 W. Totaal huisverbruik bestaat uit direct verbruik van zonnestroom plus netafname.' : 'Direct verbruik = opwek min teruglevering. Totaal huisverbruik = direct verbruik plus netafname.'}</p></article><article class="card"><h2>Vandaag <small class="energy-period">vanaf 00:00${e.daily.periodEnd ? ' · bijgewerkt ' + time(e.daily.periodEnd) : ''}</small></h2><div class="metrics">${[['solar', 'Opgewekt'], ['home', 'Totaal huisverbruik'], ['import', 'Netafname'], ['export', 'Teruggeleverd']].map(([key, label]) => `<div><small>${label}</small><b>${fmt(e.daily[key]?.value, 'kWh', 2)}</b>${e.daily[key]?.stale ? `<small class="note error">${key === 'home' ? 'Op basis van laatste opwekmeting' : 'Laatste geldige meting'}${e.daily[key].updatedAt ? ' · ' + time(e.daily[key].updatedAt) : ''}</small>` : ''}</div>`).join('')}</div><button class="pill full" data-energy-readings>Meetstanden en berekening →</button><div class="consumers"><h3>Gemeten apparaten</h3>${e.consumers.map(c => `<p>${esc(c.name)}<b>${fmt(c.value, c.unit)}</b></p>`).join('')}<p>Gas vandaag<b>${fmt(e.daily.gas?.value, 'm³', 2)}</b></p></div><button class="pill full" data-consumers>Alle gemeten apparaten →</button><p class="note">Dagtotalen vereisen recorderhistorie met een geldige beginstand. ${esc(e.daily.error || '')} ${esc((e.daily.warnings || []).join(' '))}</p></article></div>`;
}
function syncEnergyPaths() {
  const svg = $('.energy-path');
  if (!svg) return;
  const inverse = svg.getScreenCTM()?.inverse();
  if (!inverse) return;
  const center = element => {
    const rect = element.getBoundingClientRect(), point = svg.createSVGPoint();
    point.x = rect.left + rect.width / 2; point.y = rect.top + rect.height / 2;
    return point.matrixTransform(inverse);
  };
  const solar = $('.energy .solar-summary'), net = $('.energy .flow.net');
  if (!solar || !net) return;
  const solarPoint = center(solar), netPoint = center(net);
  svg.querySelector('[data-energy-path="solar"]')?.setAttribute('d', `M${solarPoint.x} ${solarPoint.y} L270 150 L300 330`);
  svg.querySelector('[data-energy-path="grid"]')?.setAttribute('d', `M${netPoint.x} ${netPoint.y} L300 330`);
}
function showEnergyReadings() {
  const d = state.energy.daily;
  const labels = { solar: 'Opwek', import: 'Netafname', export: 'Teruglevering', gas: 'Gas' };
  const rows = Object.entries(labels).map(([key, label]) => {
    const value = d[key];
    if (!value || !Number.isFinite(value.startReading) || !Number.isFinite(value.endReading)) return `<div class="room-control"><h3>${label}</h3><p>Geen volledige meetstanden beschikbaar.</p></div>`;
    const factor = value.readingUnit === 'Wh' ? 1000 : 1, unit = value.readingUnit === 'Wh' ? 'kWh' : value.readingUnit;
    return `<div class="room-control"><h3>${label} · vandaag ${fmt(value.value, value.unit, 3)}</h3><p>Stand om 00:00: <b>${fmt(value.startReading / factor, unit, 3)}</b><br>Laatste stand: <b>${fmt(value.endReading / factor, unit, 3)}</b>${value.updatedAt ? ' · ' + time(value.updatedAt) : ''}<br>Verschil: ${fmt(value.endReading / factor, '', 3)} − ${fmt(value.startReading / factor, '', 3)} = <b>${fmt(value.value, value.unit, 3)}</b></p>${value.stale ? '<p class="note error">Bron offline; laatste geldige stand van vandaag.</p>' : ''}</div>`;
  }).join('');
  const calculation = d.solar && d.import && d.export && d.home ? `<div class="room-control"><h3>Totaal huisverbruik</h3><p>Opwek + netafname − teruglevering<br>${fmt(d.solar.value, '', 3)} + ${fmt(d.import.value, '', 3)} − ${fmt(d.export.value, '', 3)} = <b>${fmt(d.home.value, 'kWh', 3)}</b></p><p class="note">Dit omvat zowel zelf gebruikte zonnestroom als stroom uit het net.</p></div>` : '';
  modal('Meetstanden · vandaag', `<p>Meetperiode: ${esc(d.day || dayOf(new Date()))} vanaf <b>00:00</b> (Europe/Amsterdam)${d.periodEnd ? ' tot ' + time(d.periodEnd) : ''}.</p><p class="note">De grote meterstanden zijn cumulatief. De kaarten tonen uitsluitend het verschil vanaf middernacht.</p>${rows}${calculation}`, 'energy-readings');
}
function musicView() {
  const s = entity(speaker), label = state.speakers.find(p => p.entity === speaker)?.name;
  return `<div class="grid music"><article class="card player"><div class="scene-row"><b>Speelt op</b>${state.speakers.map(p => `<button class="pill ${p.entity === speaker ? 'selected' : ''}" data-speaker="${esc(p.entity)}" aria-pressed="${p.entity === speaker}">${esc(p.name)}</button>`).join('')}</div>${artwork(s, 'album')}<h2>${esc(s?.title || 'Kies iets om te luisteren')}</h2><p>${esc(s?.artist || label)} · ${esc(s?.available ? s.state === 'playing' ? 'Speelt nu' : s.state === 'paused' ? 'Gepauzeerd' : 'Klaar voor muziek' : 'Speaker niet beschikbaar')}</p><div class="progress"><div class="progress-fill" id="progress"></div></div><small id="position">${duration(s?.position)} / ${duration(s?.duration)}</small>${playerControls()}<label>Volume · ${esc(label)} · <output data-volume-value>${volumePercent()}%</output><input type="range" min="0" max="100" value="${volumePercent()}" data-volume aria-label="Volume ${esc(label)}" ${offline(speaker) || busy || !(s?.features & 4) ? 'disabled' : ''}><small data-volume-status>${pendingVolumes.has(speaker) ? 'Wachten op de speaker…' : ''}</small></label></article><article class="card"><h2>Waar heb je zin in?</h2><form id="search-form"><label for="search">Zoek muziek, artiesten, albums…</label><input type="search" id="search" name="query" maxlength="160" placeholder="Wat wil je horen?" required ${!state.music.search ? 'disabled' : ''}><button class="pill full" ${!state.music.search ? 'disabled' : ''}>Zoek op alle bronnen →</button></form><div class="day">Favoriete afspeellijsten</div><div id="favorites">${state.music.library ? '<button class="pill full" data-library>Toon mijn favorieten →</button>' : empty('Favorieten zijn niet beschikbaar via de aangesloten Music Assistant-integratie.')}</div><button class="pill full" data-queue>Bekijk wachtrij →</button><p class="note">Bestemming: ${esc(label)}. Zoeken en speakerkeuze starten geen muziek.</p></article></div>`;
}
function cameraView() {
  if (!state.cameras.length) return `<article class="card"><h2>Camera’s koppelen</h2>${empty('Er zijn nog geen camera’s geconfigureerd.')}</article>`;
  const [main, ...others] = state.cameras;
  const tile = (c, primary = false) => `<article class="card camera-tile ${primary ? 'camera-primary' : ''}"><h2>${esc(c.name)}</h2><button class="camera-button" data-enlarge-camera="${esc(c.entity)}" aria-label="Vergroot ${esc(c.name)}">${cameraImage(c.entity)}</button></article>`;
  return `<div class="camera-overview">${tile(main, true)}<div class="camera-thumbnails">${others.map(c => tile(c)).join('')}</div></div><div class="camera-toolbar"><p class="note">Momentopnamen · iedere 10 seconden op de achtergrond bijgewerkt.</p><button class="pill" data-reload-camera>Beelden vernieuwen</button></div>`;
}
function cameraImage(id) { return `<img class="camera-image" data-camera-image="${esc(id)}" src="/api/camera/${encodeURIComponent(id)}?t=${Date.now()}" alt="Camerabeeld ${esc(state.cameras.find(c => c.entity === id)?.name)}"><span class="camera-error" role="status" hidden>Beeld niet beschikbaar. Probeer opnieuw te laden.</span><span class="camera-updated"></span>`; }
function render() {
  if (!state) return;
  const scroll = lastRenderedPage === page ? { content: $('#content').scrollTop, cards: [...$('#content').querySelectorAll('.card')].map(card => card.scrollTop) } : null;
  $('#title').textContent = titles[page]; $('#location').textContent = `THUIS / ${state.location}`;
  connectionStatus();
  $('nav').innerHTML = pages.map((p, i) => `<button class="${page === i ? 'active' : ''}" data-page="${i}" ${i === page ? 'aria-current="page"' : ''}><span class="nav-icon">${icons[i]}</span> ${p}</button>`).join('');
  releaseCameras($('#content'));
  $('#content').innerHTML = [energyView, roomsView, todayView, musicView, cameraView][page]();
  $('#content').scrollTop = scroll?.content || 0;
  if (scroll) $('#content').querySelectorAll('.card').forEach((card, index) => { card.scrollTop = scroll.cards[index] || 0; });
  syncEnergyPaths();
  lastRenderedPage = page;
  if (page === 3 && state.music.library) loadFavorites();
  if (dialogMode === 'room') renderRoom(selectedRoom);
  tick(); manageCamera();
}
function connectionStatus() {
  $('#connection').textContent = state.connection.live ? '● Live verbonden' : '○ Opnieuw verbinden…';
  $('#notice').textContent = state.connection.stale ? 'Home Assistant is niet bereikbaar. Laatst bekende waarden worden getoond; bediening is tijdelijk niet beschikbaar.' : !state.connection.live ? 'De liveverbinding wordt hersteld. Bediening is tijdelijk niet beschikbaar.' : '';
}
function duration(seconds) { return Number.isFinite(seconds) ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}` : '—'; }
function tick() {
  if (state) document.querySelectorAll('[data-agenda-list]').forEach(list => {
    const html = agenda(Number(list.dataset.agendaList));
    if (list.innerHTML !== html) list.innerHTML = html;
  });
  if ($('#clock')) $('#clock').textContent = time(new Date());
  if ($('#date')) $('#date').textContent = new Intl.DateTimeFormat('nl-NL', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
  const s = entity(speaker);
  if ($('#progress') && s?.duration && Number.isFinite(s?.position)) {
    const position = Math.min(s.duration, s.position + (s.state === 'playing' ? Math.max(0, (Date.now() - Date.parse(s.positionUpdatedAt || new Date())) / 1000) : 0));
    $('#progress').style.width = `${position / s.duration * 100}%`;
    $('#position').textContent = `${duration(position)} / ${duration(s.duration)}`;
  }
}
async function load() {
  try {
    const data = await api('/api/dashboard'); state = data;
    speaker ||= state.speakers[0]?.entity;
    syncVolume();
    // Avoid replacing a focused control, edited search field or pending action.
    if (!busy && !document.activeElement?.matches('input') && !$('dialog').open && !(page === 4 && $('#content [data-camera-image]'))) render();
    else { connectionStatus(); if (!busy && dialogMode === 'room') updateRoom(); }
  } catch {
    if (state) { state.connection.stale = true; state.connection.live = false; if (!$('dialog').open) render(); else if (dialogMode === 'room') renderRoom(selectedRoom); }
    $('#notice').textContent = 'Geen verbinding met de dashboardserver. Er wordt automatisch opnieuw geprobeerd.';
  }
}
async function perform(fn, message = 'Opdracht verstuurd') {
  busy = true;
  document.querySelectorAll('[data-quick],[data-media],[data-scene],[data-light],[data-brightness],[data-color],[data-volume]').forEach(b => b.disabled = true);
  try { await fn(); toast(message); } catch (e) { toast(e.message); }
  finally { busy = false; await load(); if ($('dialog').open && dialogMode === 'room') updateRoom(); }
}
function renderRoom(id) {
  selectedRoom = id; const room = state.rooms.find(r => r.id === id); if (!room) return;
  const html = room.entities.map(entity).filter(Boolean).map(e => `<div class="room-control"><div><span><b>${esc(e.name)}</b><br><small data-room-state="${esc(e.id)}">${esc(e.state)} ${esc(e.unit || '')}</small></span>${/^(light|switch)\./.test(e.id) ? `<button data-light="${esc(e.id)}" ${offline(e.id) || busy ? 'disabled' : ''}>${e.state === 'on' ? 'Uitzetten' : 'Aanzetten'}</button>` : e.id.startsWith('scene.') ? `<button data-scene="${esc(e.id)}" ${offline(e.id) || busy ? 'disabled' : ''}>Uitvoeren</button>` : ''}</div>${e.dimmable ? `<label>Helderheid<input type="range" min="0" max="100" value="${Math.round((e.brightness || 0) / 255 * 100)}" aria-label="Helderheid ${esc(e.name)}" data-brightness="${esc(e.id)}" ${offline(e.id) || busy ? 'disabled' : ''}></label>` : ''}${e.colorable ? `<label>Kleur<input type="color" value="${esc(e.color)}" aria-label="Kleur ${esc(e.name)}" data-color="${esc(e.id)}" ${offline(e.id) || busy ? 'disabled' : ''}></label>` : ''}${/^(climate|cover|fan)\./.test(e.id) ? '<small>Alleen statusweergave voor dit apparaat.</small>' : ''}</div>`).join('');
  modal(room.name, html || empty('Geen apparaten beschikbaar'), 'room');
}
function updateRoom() {
  $('#dialog-body').querySelectorAll('[data-room-state]').forEach(node => {
    const e = entity(node.dataset.roomState); if (e) node.textContent = `${e.state === 'on' ? 'Aan' : e.state === 'off' ? 'Uit' : e.state} ${e.unit || ''}`;
  });
  $('#dialog-body').querySelectorAll('[data-light]').forEach(button => {
    const e = entity(button.dataset.light); button.disabled = busy || offline(button.dataset.light);
    button.textContent = e?.state === 'on' ? 'Uitzetten' : 'Aanzetten';
  });
  $('#dialog-body').querySelectorAll('[data-brightness]').forEach(input => {
    input.disabled = busy || offline(input.dataset.brightness);
    if (document.activeElement !== input) input.value = Math.round((entity(input.dataset.brightness)?.brightness || 0) / 255 * 100);
  });
  $('#dialog-body').querySelectorAll('[data-color]').forEach(input => { input.disabled = busy || offline(input.dataset.color); if (document.activeElement !== input) input.value = entity(input.dataset.color)?.color || '#ffffff'; });
  $('#dialog-body').querySelectorAll('[data-scene]').forEach(button => button.disabled = busy || offline(button.dataset.scene));
}
function showConsumers() {
  modal('Alle gemeten apparaten', `<div class="consumers">${(state.energy.allConsumers || state.energy.consumers).map(c => `<p>${esc(c.name)}<b>${fmt(c.value, c.unit)}</b></p>`).join('')}</div><p class="note">Actueel gemeten vermogen. Technische fase- en netmetingen zijn weggelaten.</p>`, 'consumers');
}
function showWeather() {
  const w = state.weather;
  modal('Weersverwachting · ' + state.location, `${(w.daily || []).map((d, i) => `<div class="room-control"><h3>${forecastCondition(d).icon} ${i === 0 ? 'Morgen' : 'Overmorgen'} · ${esc(forecastCondition(d).label)}</h3><p>${fmt(d.min, '°', 0)} tot ${fmt(d.max, '°', 0)} · ${fmt(d.probability, '%', 0)} kans op neerslag · ${fmt(d.rain, 'mm')}</p></div>`).join('') || empty('Geen dagverwachting beschikbaar uit deze weerbron.')}<p class="note">${esc(w.source)} · ${updated(w.lastSuccessAt)}</p>`, 'weather');
}
function showWaste() {
  const w = state.waste;
  modal('Komende inzamelingen', `${w.error ? `<p class="error">${esc(w.error)}</p>` : ''}<p class="note ${w.stale ? 'error' : ''}">${updated(w.lastSuccessAt)}${w.stale ? ' · gegevens zijn verouderd' : ''}</p>${w.missingYears.length ? `<p class="error">Kalenderdekking ontbreekt voor ${w.missingYears.join(', ')}.</p>` : ''}${w.records.length ? w.records.map(r => `<div class="room-control"><b>${esc(r.title)}</b><p>${esc(dayLabel(r.date))} · ${esc(r.date)}</p></div>`).join('') : empty('Geen komende inzamelingen beschikbaar.')}`, 'waste');
}
async function showHistory(period) {
  const chooser = `<div class="history-range">${[['day', 'Dag'], ['week', 'Week'], ['month', 'Maand']].map(([key, label]) => `<button data-history="${key}" class="${key === period ? 'selected' : ''}">${label}</button>`).join('')}</div>`;
  modal('Energiehistorie', `${chooser}<p>Historie ophalen…</p>`, `history-${period}`);
  try {
    const series = await api(`/api/history?period=${period}`);
    if (dialogMode !== `history-${period}` || !$('dialog').open) return;
    const points = series.flatMap(s => s.points);
    if (!points.length) return modal('Energiehistorie', chooser + empty('Geen recorderhistorie beschikbaar voor deze periode.'), `history-${period}`);
    const times = [...new Set(points.map(p => p.time))].sort(), min = Math.min(0, ...points.map(p => p.value)), max = Math.max(1, ...points.map(p => p.value));
    const y = value => 190 - (value - min) / (max - min) * 165, zero = y(0), group = 600 / times.length, bar = Math.max(1, group / (series.length + 1));
    const columns = series.map((s, index) => s.points.map(p => {
      const label = new Intl.DateTimeFormat('nl-NL', { timeZone: tz, ...(period === 'day' ? { hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short' }) }).format(new Date(p.time));
      return `<rect class="series-${index}" x="${times.indexOf(p.time) * group + index * bar + bar / 2}" y="${Math.min(zero, y(p.value))}" width="${bar * .85}" height="${Math.max(1, Math.abs(y(p.value) - zero))}"><title>${esc(s.name)} · ${esc(label)}: ${p.value < 0 ? '−' : ''}${watts(p.value)} · ${fmt(p.seconds / 3600, 'uur meetdekking')}</title></rect>`;
    }).join('')).join('');
    const labels = times.filter((_, i) => i % Math.max(1, Math.ceil(times.length / 6)) === 0).map(t => `<text x="${times.indexOf(t) * group}" y="215">${esc(new Intl.DateTimeFormat('nl-NL', { timeZone: tz, ...(period === 'day' ? { hour: '2-digit' } : { day: 'numeric', month: 'numeric' }) }).format(new Date(t)))}</text>`).join('');
    modal('Energiehistorie', `${chooser}<p>${watts(max)} boven · ${min < 0 ? '−' : ''}${watts(min)} onder</p><svg class="chart" viewBox="-10 0 640 230" role="img" aria-label="Kolommen met gemiddeld vermogen per ${period === 'day' ? 'uur' : 'dag'}; negatief netvermogen betekent teruglevering"><line x1="0" x2="600" y1="${zero}" y2="${zero}"/>${columns}${labels}</svg><div class="chart-legend">${series.map((s, i) => `<span class="series-${i}">● ${esc(s.name)}</span>`).join('')}</div><p class="note">Tijdgewogen gemiddeld vermogen in watt per ${period === 'day' ? 'uur' : 'dag'}. Negatief netvermogen is teruglevering. Ontbrekende metingen worden niet als nul getoond; de eerste en laatste kolom kunnen een deelperiode zijn.</p>`, `history-${period}`);
  } catch (e) { if (dialogMode === `history-${period}`) modal('Energiehistorie', chooser + empty(e.message), `history-${period}`); }
}
let results = [];
function resultButtons(items) {
  results = items; const target = state.speakers.find(s => s.entity === speaker)?.name;
  return `<p>Afspelen op <b>${esc(target)}</b>. Kies een resultaat om te starten.</p>${items.length ? items.map((r, i) => `<button class="playlist" data-result="${i}">${r.image ? `<img class="art" src="${esc(r.image)}" alt="">` : '<span class="art">♫</span>'}<span><b>${esc(r.name)}</b><small>${esc(r.artist || r.type)} · ${esc(r.provider)} → ${esc(target)}</small></span></button>`).join('') : empty('Geen resultaten gevonden.')}`;
}
async function loadFavorites() {
  const container = $('#favorites'); if (!container) return;
  if (favorites) {
    container.innerHTML = favorites.length ? favorites.map((r, i) => `<button class="playlist" data-favorite="${i}">${r.image ? `<img class="art" src="${esc(r.image)}" alt="">` : '<span class="art">♫</span>'}<span><b>${esc(r.name)}</b><small>${esc(r.provider)} · Afspelen op ${esc(state.speakers.find(p => p.entity === speaker)?.name)}</small></span></button>`).join('') : empty('Nog geen favoriete afspeellijsten in Music Assistant.');
    return;
  }
  if (favoriteRequest) return; favoriteRequest = true; container.innerHTML = '<p>Favorieten ophalen…</p>';
  try { favorites = await api('/api/music/library', {}); if ($('#favorites')) loadFavorites(); }
  catch (e) { if ($('#favorites')) $('#favorites').innerHTML = `<p class="error">${esc(e.message)}</p><button data-library>Opnieuw proberen</button>`; }
  finally { favoriteRequest = false; }
}
async function musicResults(kind, query) {
  modal(kind === 'search' ? 'Zoekresultaten' : 'Favoriete afspeellijsten', '<p>Bibliotheek ophalen…</p>', 'music');
  try { const items = await api(`/api/music/${kind}`, { query }); if (dialogMode === 'music' && $('dialog').open) $('#dialog-body').innerHTML = resultButtons(items); }
  catch (e) { if (dialogMode === 'music') $('#dialog-body').innerHTML = empty(e.message); }
}
function navigate(next) { page = Math.max(0, Math.min(4, next)); volumeEditing = false; render(); window.scrollTo({ top: 0 }); }
document.addEventListener('click', async event => {
  const b = event.target.closest('button'); if (!b || b.disabled) return;
  if (b.id === 'home') navigate(2);
  if (b.id === 'theme') { document.body.classList.toggle('night'); try { localStorage.setItem('theme', document.body.classList.contains('night') ? 'night' : ''); } catch {} themeLabel(); }
  if (b.id === 'close-dialog') $('dialog').close();
  if (b.dataset.page !== undefined) navigate(Number(b.dataset.page));
  if (!state) return;
  if (b.dataset.quick !== undefined) {
    const a = state.quickActions[Number(b.dataset.quick)], scene = a.entities[0].startsWith('scene.'), on = a.entities.some(id => entity(id)?.state === 'on');
    perform(() => Promise.all(a.entities.map(id => api('/api/action', { entity: id, action: a.action || (scene ? 'activate' : on ? 'off' : 'on') }))));
  }
  if (b.dataset.scene) perform(() => api('/api/action', { entity: b.dataset.scene, action: 'activate' }));
  if (b.dataset.light) perform(() => api('/api/action', { entity: b.dataset.light, action: entity(b.dataset.light).state === 'on' ? 'off' : 'on' }));
  if (b.dataset.media) perform(() => api('/api/action', { entity: speaker, action: b.dataset.media }));
  if (b.dataset.speaker) { speaker = b.dataset.speaker; render(); }
  if (b.dataset.room) renderRoom(b.dataset.room);
  if (b.hasAttribute('data-waste')) showWaste();
  if (b.hasAttribute('data-consumers')) showConsumers();
  if (b.hasAttribute('data-energy-readings')) showEnergyReadings();
  if (b.hasAttribute('data-weather')) showWeather();
  if (b.hasAttribute('data-agenda')) modal('Agenda Gezin', `<div data-agenda-list="Infinity">${agenda(Infinity)}</div><p class="note">${updated(state.calendar.lastSuccessAt)} · komende 14 dagen vanaf nu</p>`, 'agenda');
  if (b.dataset.event !== undefined) { const e = state.calendar.events[Number(b.dataset.event)]; modal(e.title, `<p>${esc(dayLabel(e.allDay ? e.start : dayOf(e.start)))} · ${e.allDay ? 'Hele dag' : `${time(e.start)}${e.end ? ` – ${time(e.end)}` : ''}`}</p><p>${esc(e.location)}</p><p>${esc(e.description)}</p>`); }
  if (b.dataset.history) showHistory(b.dataset.history);
  if (b.hasAttribute('data-library')) musicResults('library');
  if (b.hasAttribute('data-queue')) {
    modal('Wachtrij · ' + state.speakers.find(s => s.entity === speaker)?.name, '<p>Wachtrij ophalen…</p>', 'queue');
    try {
      const q = await api('/api/music/queue', { entity: speaker });
      if (dialogMode === 'queue' && $('dialog').open) $('#dialog-body').innerHTML = `<div class="day">Nu</div><p>${esc(q.current || 'Geen muziek')}</p><div class="day">Hierna</div><p>${esc(q.next || 'Geen volgend nummer')}</p><p class="note">${esc(q.count ?? 0)} nummers · Shuffle ${q.shuffle ? 'aan' : 'uit'} · herhalen ${esc(q.repeat)}<br>Home Assistant levert het huidige en volgende nummer; de volledige lijst beheer je in Music Assistant.</p>`;
    } catch (e) { if (dialogMode === 'queue') $('#dialog-body').innerHTML = empty(e.message); }
  }
  if (b.dataset.result !== undefined) { const item = results[Number(b.dataset.result)]; perform(async () => { await api('/api/music/play', { entity: speaker, uri: item.uri }); $('dialog').close(); }); }
  if (b.dataset.favorite !== undefined) { const item = favorites[Number(b.dataset.favorite)]; perform(() => api('/api/music/play', { entity: speaker, uri: item.uri })); }
  if (b.dataset.enlargeCamera) { modal(state.cameras.find(c => c.entity === b.dataset.enlargeCamera).name, cameraImage(b.dataset.enlargeCamera), 'camera'); manageCamera(); }
  if (b.hasAttribute('data-reload-camera')) refreshCameras();
});
document.addEventListener('pointerdown', event => { if (event.target.hasAttribute?.('data-volume')) volumeEditing = true; });
document.addEventListener('pointerup', () => { volumeEditing = false; });
document.addEventListener('pointercancel', () => { volumeEditing = false; syncVolume(); });
document.addEventListener('input', event => {
  if (event.target.hasAttribute?.('data-volume') && $('[data-volume-value]')) $('[data-volume-value]').textContent = `${event.target.value}%`;
});
document.addEventListener('change', event => {
  if (event.target.hasAttribute('data-volume')) setVolume(event.target);
  if (event.target.dataset.color) perform(() => api('/api/action', { entity: event.target.dataset.color, action: 'color', value: event.target.value }));
  if (event.target.dataset.brightness) perform(() => api('/api/action', { entity: event.target.dataset.brightness, action: 'brightness', value: Number(event.target.value) }));
});
document.addEventListener('submit', event => { if (event.target.id === 'search-form') { event.preventDefault(); musicResults('search', new FormData(event.target).get('query')); } });
function cameraFailure(img) {
  const message = img.nextElementSibling;
  if (!img.dataset.loaded) img.hidden = true;
  message.textContent = img.dataset.loaded ? 'Bijwerken mislukt · laatst beschikbare beeld wordt getoond.' : 'Beeld niet beschikbaar. Probeer opnieuw te laden.';
  message.hidden = false;
}
document.addEventListener('load', event => {
  const img = event.target;
  if (img.hasAttribute?.('data-camera-image')) { img.dataset.loaded = 'true'; img.hidden = false; img.nextElementSibling.hidden = true; const caption = img.parentElement.querySelector('.camera-updated'); if (caption) caption.textContent = 'Opgehaald ' + new Intl.DateTimeFormat('nl-NL', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date()); }
}, true);
document.addEventListener('error', event => {
  if (event.target.hasAttribute?.('data-camera-image')) cameraFailure(event.target);
  if (event.target.classList?.contains('album') || event.target.classList?.contains('art')) event.target.alt = 'Albumhoes niet beschikbaar';
}, true);
const cameraRequests = new WeakSet();
async function refreshCamera(img) {
  if (cameraRequests.has(img) || !img.isConnected || document.hidden) return;
  cameraRequests.add(img);
  let nextUrl;
  try {
    const response = await fetch(`/api/camera/${encodeURIComponent(img.dataset.cameraImage)}?t=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error();
    nextUrl = URL.createObjectURL(await response.blob());
    const next = new Image(); next.src = nextUrl; await next.decode();
    if (!img.isConnected) return;
    const previous = img.dataset.blob;
    img.src = nextUrl; img.dataset.blob = nextUrl; nextUrl = null;
    img.dataset.loaded = 'true'; img.hidden = false; img.nextElementSibling.hidden = true;
    if (previous) URL.revokeObjectURL(previous);
  } catch { if (img.isConnected) cameraFailure(img); }
  finally { if (nextUrl) URL.revokeObjectURL(nextUrl); cameraRequests.delete(img); }
}
function releaseCameras(root) { root.querySelectorAll('[data-camera-image]').forEach(img => { if (img.dataset.blob) URL.revokeObjectURL(img.dataset.blob); }); }
function refreshCameras() { document.querySelectorAll('[data-camera-image]').forEach(refreshCamera); }
function manageCamera() {
  const active = (page === 4 || dialogMode === 'camera') && !document.hidden;
  if (!active) { clearInterval(cameraTimer); cameraTimer = null; }
  else if (!cameraTimer) cameraTimer = setInterval(refreshCameras, 10000);
}
// Both ends of the gesture must be on the backdrop; dragging out of a slider does not close it.
let backdropPress = false;
function outsideDialog(event) {
  const rect = $('dialog').getBoundingClientRect();
  return event.target === $('dialog') && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom);
}
$('dialog').addEventListener('pointerdown', event => { backdropPress = outsideDialog(event); });
$('dialog').addEventListener('click', event => { if (backdropPress && outsideDialog(event)) $('dialog').close(); backdropPress = false; });
$('dialog').addEventListener('close', () => { releaseCameras($('#dialog-body')); $('#dialog-body').innerHTML = ''; dialogMode = null; if (page === 4) { connectionStatus(); manageCamera(); } else render(); });
document.addEventListener('visibilitychange', () => { manageCamera(); if (!document.hidden) { refreshCameras(); load(); } });
window.addEventListener('resize', syncEnergyPaths, { passive: true });
let start;
$('#content').addEventListener('touchstart', e => { start = null; if (!e.target.closest('button,input,select,a,[data-no-swipe]')) start = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }, { passive: true });
$('#content').addEventListener('touchend', e => { if (!start) return; const dx = e.changedTouches[0].clientX - start.x, dy = e.changedTouches[0].clientY - start.y; if (Math.abs(dx) > 80 && Math.abs(dx) > Math.abs(dy) * 1.5) navigate(page + (dx < 0 ? 1 : -1)); start = null; }, { passive: true });
function themeLabel() { $('#theme').textContent = document.body.classList.contains('night') ? '☀ Warm wonen' : '☾ Avondrust'; }
try { document.body.classList.toggle('night', localStorage.getItem('theme') === 'night'); } catch { /* Browser storage may be disabled. */ }
themeLabel(); await load(); let lastPoll = 0; setInterval(() => { if (!document.hidden && !busy && (dialogMode === 'room' || Date.now() - lastPoll >= 5000)) { lastPoll = Date.now(); load(); } }, 1000); setInterval(tick, 1000);
