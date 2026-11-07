// Isolated fixture: never connects to Home Assistant or operates a speaker.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from '../server/index.js';
import { HomeAssistant } from '../server/ha.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const config = JSON.parse(await readFile('config/dashboard.example.json'));
config.screensaver = { enabled: false }; config.speakers = [{ name: 'Test speaker', entity: 'media_player.test' }];
const ha = new HomeAssistant(null, null); ha.connected = true; ha.lastSuccessAt = new Date().toISOString();
ha.entities = [{ entity_id: 'media_player.test', platform: 'music_assistant', config_entry_id: 'entry' }];
ha.states.set('media_player.test', { entity_id: 'media_player.test', state: 'idle', attributes: { supported_features: 65535 } });
ha.services = [{ domain: 'music_assistant', services: { search: {}, play_media: { fields: { radio_mode: {} } } } }];
const app = await createApp({ config, ha });
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
try {
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 844 } }), errors = [], calls = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/api/music/search', route => route.fulfill({ json: [{ name: 'Test song', uri: 'apple_music://track/42', type: 'track', provider: 'Apple Music' }, { name: 'Test playlist', uri: 'library://playlist/1', type: 'playlist', provider: 'Library' }] }));
    let release;
    await page.route('**/api/music/play', async route => { calls.push(route.request().postDataJSON()); await new Promise(resolve => { release = resolve; }); await route.fulfill({ json: { accepted: true } }); });
    await page.goto(`http://127.0.0.1:${app.server.address().port}`);
    await page.locator('[data-page="3"]').click();
    await page.locator('#search-form input').fill('Test');
    await page.locator('#search-form').evaluate(form => form.requestSubmit());
    const radio = page.locator('[data-radio]');
    await radio.waitFor(); assert.equal(await radio.count(), 1);
    assert.equal(await page.locator('button button').count(), 0);
    await radio.click();
    await page.waitForFunction(() => document.querySelector('[data-radio]')?.disabled);
    assert.equal(calls.length, 1); assert.equal(calls[0].mode, 'radio'); assert.equal(calls[0].entity, 'media_player.test');
    release();
    await page.getByRole('heading', { name: 'Radiomix aangevraagd' }).waitFor();
    assert.ok((await page.locator('#dialog-body').innerText()).includes('nog niet bevestigd'));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []); await page.close();
  }
  console.log('Music browser checks passed at tablet and mobile widths');
} finally { await browser.close(); app.stop(); }
