import { fetchJSON } from './utils.js';

export class HomeAssistant {
  constructor(url, token) {
    this.base = url ? new URL(url).origin : null;
    this.token = token;
    this.states = new Map(); this.connected = false; this.lastSuccessAt = null;
    this.areas = []; this.entities = []; this.devices = []; this.services = [];
    this.pending = new Map(); this.sequence = 0; this.retry = 1000;
    this.lastFailure = new Map();
  }
  log(event, details = {}) {
    console.info('[home-assistant]', JSON.stringify({ event, ...details }));
  }
  logFailure(event, error) {
    // Error messages from fetch/WebSocket can contain the configured URL. Keep
    // diagnostics useful without ever writing URLs, request data, or tokens.
    const status = Number(error?.message?.match(/HTTP (\d{3})/)?.[1]) || undefined;
    const code = error?.cause?.code || error?.code || undefined;
    const name = error?.name || 'Error';
    const key = `${event}:${status || ''}:${code || ''}:${name}`;
    const now = Date.now();
    if (now - (this.lastFailure.get(key) || 0) < 300000) return;
    this.lastFailure.set(key, now);
    console.warn('[home-assistant]', JSON.stringify({ event, name, ...(status ? { status } : {}), ...(code ? { code } : {}) }));
  }
  async request(path, body) {
    if (!this.base || !this.token) throw new Error('Stel HOMEASSISTANT_URL en HOMEASSISTANT_API_KEY in');
    return fetchJSON(`${this.base}/api/${path}`, { headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }, ...(body !== undefined ? { method: 'POST', body: JSON.stringify(body) } : {}) });
  }
  service(domain, service, data, response = false) { return this.request(`services/${domain}/${service}${response ? '?return_response' : ''}`, data); }
  hasService(domain, service) { return !!this.services.find(s => s.domain === domain)?.services?.[service]; }
  closeSocket(socket) {
    if (socket && (socket.readyState === 0 || socket.readyState === 1)) socket.close();
  }
  async refresh() {
    try {
      const states = await this.request('states');
      if (!Array.isArray(states)) throw new Error('Ongeldige Home Assistant-status');
      this.states = new Map(states.map(s => [s.entity_id, s]));
      this.lastSuccessAt = new Date().toISOString();
      for (const key of this.lastFailure.keys()) if (key.startsWith('rest_refresh_failed:')) this.lastFailure.delete(key);
      return states;
    } catch (error) {
      this.logFailure('rest_refresh_failed', error);
      throw error;
    }
  }
  command(type, data = {}) {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.readyState !== 1 || !this.connected) return reject(new Error('Liveverbinding niet beschikbaar'));
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Home Assistant antwoordt niet')); }, 12000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, type, ...data }));
    });
  }
  start() {
    if (!this.base || !this.token) return;
    this.stopped = false;
    this.connect();
    this.poll = setInterval(() => { if (!this.connected) this.refresh().catch(() => {}); }, 30000);
    this.heartbeat = setInterval(() => {
      if (this.connected) {
        const socket = this.socket;
        this.command('ping').then(() => { this.lastSuccessAt = new Date().toISOString(); }).catch(error => {
          this.logFailure('websocket_heartbeat_failed', error);
          this.closeSocket(socket);
        });
      }
    }, 30000);
  }
  connect() {
    if (this.stopped) return;
    let socket;
    try { socket = this.socket = new WebSocket(`${this.base.replace(/^http/, 'ws')}/api/websocket`); }
    catch (error) {
      this.logFailure('websocket_connect_failed', error);
      this.scheduleReconnect();
      return;
    }
    this.log('websocket_connecting');
    const timeout = setTimeout(() => {
      if (!this.connected) this.logFailure('websocket_handshake_timeout', new Error('Authentication timeout'));
      this.closeSocket(socket);
    }, 15000);
    socket.addEventListener('message', async ({ data }) => {
      if (this.socket !== socket) return;
      let message; try { message = JSON.parse(data); } catch { return; }
      if (message.type === 'auth_required') socket.send(JSON.stringify({ type: 'auth', access_token: this.token }));
      if (message.type === 'auth_ok') {
        clearTimeout(timeout); this.connected = true; this.retry = 1000;
        this.log('websocket_authenticated');
        try {
          await this.command('subscribe_events', { event_type: 'state_changed' });
          await this.refresh();
          const results = await Promise.allSettled([
            this.command('config/area_registry/list'), this.command('config/entity_registry/list'), this.command('config/device_registry/list'), this.request('services')
          ]);
          ['areas', 'entities', 'devices', 'services'].forEach((key, i) => { if (results[i].status === 'fulfilled') this[key] = results[i].value; });
        } catch (error) {
          this.logFailure('websocket_initialization_failed', error);
          /* REST fallback and reconnect keep old states visible. */
        }
      }
      if (message.type === 'auth_invalid') {
        this.logFailure('websocket_auth_rejected', new Error('Home Assistant rejected the token'));
        this.closeSocket(socket);
      }
      if (message.type === 'result' || message.type === 'pong') {
        const p = this.pending.get(message.id);
        if (p) { clearTimeout(p.timer); this.pending.delete(message.id); message.success || message.type === 'pong' ? p.resolve(message.result) : p.reject(new Error('Home Assistant ondersteunt deze aanvraag niet')); }
      }
      if (message.type === 'event' && message.event?.data?.entity_id) {
        const { entity_id, new_state } = message.event.data;
        new_state ? this.states.set(entity_id, new_state) : this.states.delete(entity_id);
        this.lastSuccessAt = new Date().toISOString();
      }
    });
    socket.addEventListener('error', () => {
      if (this.socket !== socket) return;
      // WebSocket emits close after a connection error. Calling close here can
      // recursively emit error in Node's Undici WebSocket implementation.
      this.logFailure('websocket_error', new Error('WebSocket transport error'));
    });
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      clearTimeout(timeout); this.connected = false;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Verbinding verbroken')); }
      this.pending.clear();
      this.log('websocket_closed', { retrying: !this.stopped, retryMs: this.stopped ? 0 : this.retry });
      if (!this.stopped) this.scheduleReconnect();
    });
  }
  scheduleReconnect() {
    if (this.stopped) return;
    const delay = this.retry;
    this.reconnect = setTimeout(() => this.connect(), delay);
    this.retry = Math.min(60000, this.retry * 2);
  }
  stop() { this.stopped = true; clearInterval(this.poll); clearInterval(this.heartbeat); clearTimeout(this.reconnect); this.closeSocket(this.socket); }
  rooms() {
    return this.areas.map(area => {
      const ids = this.entities.filter(e => !e.disabled_by && (e.area_id === area.area_id || (!e.area_id && this.devices.find(d => d.id === e.device_id)?.area_id === area.area_id))).map(e => e.entity_id);
      return { id: area.area_id, name: area.name, entities: ids.filter(id => (!id.endsWith('_led') && /^(light|scene|climate|cover|fan)\./.test(id)) || this.states.get(id)?.attributes.device_class === 'temperature') };
    }).filter(a => a.entities.length);
  }
  isMusicPlayer(entity) { return this.entities.some(e => e.entity_id === entity && e.platform === 'music_assistant' && !e.disabled_by); }
  supportsRadio() {
    const service = this.services.find(s => s.domain === 'music_assistant')?.services?.play_media;
    return !!service?.fields && Object.hasOwn(service.fields, 'radio_mode');
  }
  musicEntry(speakers) {
    return this.entities.find(e => speakers.some(s => s.entity === e.entity_id) && e.platform === 'music_assistant')?.config_entry_id;
  }
}
