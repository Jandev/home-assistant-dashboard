// Optional browser QA: install Playwright separately; no browser enters the runtime image.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.DASHBOARD_URL || 'http://127.0.0.1:8080';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage(), errors = [], commands = [], reports = [];
  let overrideLight, pendingLight, volumeOverride;
  await page.route('**/api/dashboard', async route => {
    const response = await route.fetch(), data = await response.json();
    if (overrideLight && data.entities[overrideLight.id]) data.entities[overrideLight.id].state = overrideLight.state;
    if (volumeOverride && data.entities[volumeOverride.id]) data.entities[volumeOverride.id].volume = volumeOverride.value;
    return route.fulfill({ json: data });
  });
  page.on('pageerror', e => errors.push(e.message));
  // Intercept all write endpoints: browser QA must never operate real devices.
  await page.route('**/api/action', route => {
    commands.push(route.request().postDataJSON());
    if (pendingLight) { const change = pendingLight; pendingLight = null; setTimeout(() => overrideLight = change, 400); }
    return route.fulfill({ json: { accepted: true } });
  });
  await page.route('**/api/music/play', route => { commands.push(route.request().postDataJSON()); return route.fulfill({ json: { accepted: true } }); });
  await page.route('**/api/camera/**', route => route.fulfill({ status: 503, json: { error: 'QA offline camera' } }));
  for (const [width, height] of [[1920, 1080], [1280, 720], [1024, 600], [390, 844]]) {
    await page.setViewportSize({ width, height });
    await page.goto(base); await page.locator('#clock').waitFor();
    for (const name of ['Vandaag', 'Energie', 'Huis', 'Muziek', 'Camera’s']) {
      await page.getByRole('navigation').getByRole('button', { name: new RegExp(`${name}$`) }).click();
      const report = await page.evaluate(({ name, width, height }) => ({
        name, width, height, overflow: document.documentElement.scrollWidth > width,
        heightUsed: document.documentElement.scrollHeight,
        footerBottom: document.querySelector('.shell>footer').getBoundingClientRect().bottom,
        navBottom: document.querySelector('nav').getBoundingClientRect().bottom,
        contentBottom: document.querySelector('#content').getBoundingClientRect().bottom,
        navTop: document.querySelector('nav').getBoundingClientRect().top,
        smallControls: [...document.querySelectorAll('button,input[type=range]')].filter(e => {
          const r = e.getBoundingClientRect(); return r.width > 0 && (r.width < 47.9 || r.height < 47.9);
        }).map(e => e.getAttribute('aria-label') || e.textContent.trim())
      }), { name, width, height });
      assert.equal(report.overflow, false, `Horizontale overflow op ${name} ${width}`);
      assert.equal(report.smallControls.length, 0, `Te kleine bediening: ${report.smallControls.join(', ')}`);
      assert.ok(report.footerBottom <= height && report.footerBottom >= height - 18, `Footer moet onderaan blijven op ${name} ${width}`);
      assert.ok(report.contentBottom <= report.navTop + 1, `Inhoud mag niet onder de navigatie vallen op ${name}`);
      if (name === 'Vandaag' && width >= 1024) assert.ok(report.heightUsed <= height, `Vandaag past niet op ${width}×${height}: ${report.heightUsed}px`);
      reports.push(report);
    }
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole('button', { name: 'Ga naar Vandaag' }).click();
  await page.getByRole('button', { name: 'Alle afspraken' }).click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('button', { name: 'Sluiten', exact: true }).click();
  await page.getByRole('button', { name: 'Wissel lichte en donkere weergave' }).click();
  assert.ok(await page.locator('body').evaluate(e => e.classList.contains('night')));
  await page.reload(); await page.locator('#clock').waitFor();
  assert.ok(await page.locator('body').evaluate(e => e.classList.contains('night')));
  await page.getByRole('navigation').getByRole('button', { name: /Muziek$/ }).click();
  await page.locator('[data-speaker]').last().click();
  assert.equal(commands.length, 0, 'Speakerkeuze mag geen muziek starten');
  const speakerId = await page.locator('[data-speaker].selected').getAttribute('data-speaker');
  volumeOverride = { id: speakerId, value: 1 };
  await page.waitForFunction(() => document.querySelector('[data-volume]')?.value === '100');
  await page.locator('[data-volume]').evaluate(input => { input.value = '50'; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.waitForFunction(() => !document.querySelector('[data-volume]')?.disabled);
  assert.equal(await page.locator('[data-volume]').inputValue(), '50');
  assert.equal(commands.at(-1).value, .5);
  await page.getByRole('button', { name: 'Wissel lichte en donkere weergave' }).click();
  // An unrelated render must not replace the pending 50% with stale 100%.
  await page.locator('[data-speaker].selected').click();
  assert.equal(await page.locator('[data-volume]').inputValue(), '50');
  volumeOverride.value = .5;
  await page.waitForFunction(() => document.querySelector('[data-volume-status]')?.textContent === '');
  assert.equal(await page.locator('[data-volume]').inputValue(), '50');
  // External updates must still reach a focused but idle slider.
  await page.locator('[data-volume]').focus(); volumeOverride.value = .35;
  await page.waitForFunction(() => document.querySelector('[data-volume]')?.value === '35');
  await page.locator('[data-volume]').blur();
  commands.length = 0;
  await page.locator('[data-favorite]').first().waitFor();
  await page.getByRole('navigation').getByRole('button', { name: /Huis$/ }).click();
  await page.locator('[data-room]').first().click();
  const light = page.locator('[data-light]:enabled').first();
  await light.waitFor();
  const lightId = await light.getAttribute('data-light');
  const expected = (await light.textContent()) === 'Uitzetten' ? 'Aanzetten' : 'Uitzetten';
  pendingLight = { id: lightId, state: expected === 'Aanzetten' ? 'off' : 'on' };
  await light.click();
  await page.waitForFunction(() => !document.querySelector('[data-light]')?.disabled);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].entity, lightId);
  assert.ok(['on', 'off'].includes(commands[0].action));
  await page.waitForFunction(({ id, text }) => document.querySelector(`[data-light="${id}"]`)?.textContent === text, { id: lightId, text: expected });
  await page.getByRole('button', { name: 'Sluiten', exact: true }).click();
  await page.getByRole('navigation').getByRole('button', { name: /Muziek$/ }).click();
  await page.screenshot({ path: '/tmp/dashboard-music-qa.png', fullPage: true });
  await page.getByRole('button', { name: 'Ga naar Vandaag' }).click();
  assert.equal(await page.getByText('Binnen', { exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Open afvalkalender' }).click();
  await page.getByRole('dialog').getByRole('heading', { name: 'Komende inzamelingen' }).waitFor();
  // A click within dialog padding must stay open; a real backdrop click closes.
  const rect = await page.getByRole('dialog').boundingBox();
  await page.mouse.click(rect.x + 8, rect.y + rect.height / 2);
  assert.ok(await page.getByRole('dialog').isVisible());
  await page.mouse.click(3, 3);
  await page.waitForFunction(() => !document.querySelector('dialog').open);
  const wasteRatio = await page.evaluate(() => { const button = document.querySelector('[data-waste]'); return button.getBoundingClientRect().width / button.parentElement.getBoundingClientRect().width; });
  assert.ok(wasteRatio > .29 && wasteRatio < .35, `Afvalknop moet circa een derde van de statusbalk zijn (gemeten ${wasteRatio})`);
  assert.ok(await page.locator('.weather-symbol svg').isVisible());
  const outlook = await page.locator('.outlook-temp').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().top));
  assert.equal(outlook.length, 2);
  assert.ok(Math.abs(outlook[0] - outlook[1]) < 1, 'Temperaturen van morgen en overmorgen moeten uitlijnen');
  await page.locator('[data-weather]').click();
  await page.getByRole('dialog').getByText(/Overmorgen/).waitFor();
  await page.getByRole('button', { name: 'Sluiten', exact: true }).click();
  await page.getByRole('navigation').getByRole('button', { name: /Energie$/ }).click();
  await page.locator('[data-consumers]').click();
  await page.getByRole('dialog').getByRole('heading', { name: 'Alle gemeten apparaten' }).waitFor();
  await page.getByRole('button', { name: 'Sluiten', exact: true }).click();
  await page.locator('[data-history]').click();
  await page.locator('.chart rect').first().waitFor();
  assert.equal(await page.locator('.chart polyline').count(), 0);
  await page.getByRole('button', { name: 'Sluiten', exact: true }).click();
  await page.unroute('**/api/camera/**');
  let failCamera = false, cameraRequests = 0;
  // A valid decoded image, followed by an upstream error: keep the last frame.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9XcAAAAASUVORK5CYII=', 'base64');
  await page.route('**/api/camera/**', route => { cameraRequests++; return failCamera ? route.fulfill({ status: 503, json: {} }) : route.fulfill({ contentType: 'image/png', body: png }); });
  await page.getByRole('navigation').getByRole('button', { name: /Camera’s$/ }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-camera-image]')].every(img => img.dataset.loaded));
  assert.equal(await page.locator('[data-camera-image]').count(), 5);
  assert.equal(await page.locator('.camera-primary [data-camera-image]').getAttribute('data-camera-image'), 'camera.nvr_channel_2');
  assert.equal(await page.locator('.camera-error:visible').count(), 0);
  const initialCameraRequests = cameraRequests;
  // Wait for the actual recurring timer, without clicking the refresh button.
  await page.waitForFunction(() => [...document.querySelectorAll('[data-camera-image]')].every(img => img.dataset.blob));
  assert.ok(cameraRequests >= initialCameraRequests + 5, 'Alle vijf camera’s moeten automatisch verversen');
  const previousFrames = await page.locator('#content [data-camera-image]').evaluateAll(images => images.map(img => img.src));
  await page.waitForFunction(previous => [...document.querySelectorAll('#content [data-camera-image]')].every((img, i) => img.src !== previous[i]), previousFrames);
  await page.getByRole('button', { name: 'Ga naar Vandaag' }).click();
  const afterLeaving = cameraRequests;
  await new Promise(resolve => setTimeout(resolve, 11000));
  assert.equal(cameraRequests, afterLeaving, 'Camera’s mogen buiten de camerapagina niet blijven ophalen');
  await page.getByRole('navigation').getByRole('button', { name: /Camera’s$/ }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-camera-image]')].every(img => img.dataset.loaded));
  failCamera = true;
  await page.locator('[data-reload-camera]').click();
  await page.locator('.camera-error:visible').first().waitFor();
  assert.equal(await page.locator('[data-camera-image]:visible').count(), 5);
  const frames = await page.locator('#content [data-camera-image]').evaluateAll(images => images.map(img => img.src));
  await page.locator('[data-enlarge-camera]').first().click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('button', { name: 'Sluiten', exact: true }).click();
  assert.deepEqual(await page.locator('#content [data-camera-image]').evaluateAll(images => images.map(img => img.src)), frames, 'Vergroting sluiten mag de overzichtsbeelden niet opnieuw laden');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ reports, browserErrors: errors.length, deviceCommands: commands.length }, null, 2));
} finally { await browser.close(); }
