import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.js';
import { HomeAssistant } from '../server/ha.js';

async function setup(t) {
  const ha = new HomeAssistant(null, null), calls = [];
  ha.connected = true;
  ha.entities = [{ entity_id: 'media_player.test', platform: 'music_assistant', config_entry_id: 'entry' }];
  ha.states.set('media_player.test', { state: 'idle', attributes: {} });
  ha.services = [{ domain: 'music_assistant', services: { search: {}, play_media: { fields: { radio_mode: {} } } } }];
  ha.service = async (domain, service, data) => {
    calls.push({ domain, service, data });
    return { service_response: { items: [{ uri: 'apple_music://track/42', name: 'Song', media_type: 'track' }, { uri: 'library://playlist/1', name: 'List', media_type: 'playlist' }] } };
  };
  const config = { quickActions: [], speakers: [{ entity: 'media_player.test' }], cameras: [], energy: { consumers: [] } };
  const app = await createApp({ config, ha });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.stop());
  const post = (path, data) => fetch(`http://127.0.0.1:${app.server.address().port}/api/music/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dashboard-Request': '1' }, body: JSON.stringify(data) });
  await post('search', { query: 'Song' }); calls.length = 0;
  const play = (extra = {}) => post('play', { entity: 'media_player.test', uri: 'apple_music://track/42', ...extra });
  return { ha, calls, play };
}
test('normal playback stays compatible; radio sends exact URI, type, target and replace', async t => {
  const { play, calls } = await setup(t);
  assert.equal((await play()).status, 200);
  assert.deepEqual(calls[0].data, { entity_id: 'media_player.test', media_id: 'apple_music://track/42', media_type: 'track', enqueue: 'replace' });
  assert.equal((await play({ mode: 'radio' })).status, 200);
  assert.deepEqual(calls[1].data, { ...calls[0].data, radio_mode: true });
});
test('radio rejects invalid mode, playlist, unknown URI and target without operating devices', async t => {
  const { play, calls, ha } = await setup(t);
  for (const [extra, status] of [[{ mode: 'invalid' }, 400], [{ mode: false }, 400], [{ mode: 'radio', uri: 'library://playlist/1' }, 400], [{ uri: 'unknown' }, 409], [{ entity: 'media_player.other' }, 409]]) assert.equal((await play(extra)).status, status);
  ha.entities[0].platform = 'sonos';
  assert.equal((await play({ mode: 'radio' })).status, 409);
  ha.entities[0].platform = 'music_assistant'; ha.services[0].services.play_media.fields = {};
  assert.equal((await play({ mode: 'radio' })).status, 501);
  ha.states.get('media_player.test').state = 'unavailable';
  assert.equal((await play({ mode: 'radio' })).status, 409);
  assert.equal(calls.length, 0);
});
test('radio failure hides upstream details and releases the speaker lock', async t => {
  const { play, ha } = await setup(t);
  ha.service = async () => { throw new Error('SECRET_TOKEN'); };
  const response = await play({ mode: 'radio' });
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes('SECRET_TOKEN'));
  ha.service = async () => ({});
  assert.equal((await play({ mode: 'radio' })).status, 200);
});
test('overlapping requests on one speaker invoke play_media only once', async t => {
  const { play, ha } = await setup(t);
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  ha.service = () => { started(); return new Promise(resolve => { release = resolve; }); };
  const first = play({ mode: 'radio' }); await entered;
  try { assert.equal((await play({ mode: 'radio' })).status, 409); }
  finally { release({}); }
  assert.equal((await first).status, 200);
});
