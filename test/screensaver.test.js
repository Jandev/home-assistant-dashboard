import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createScreensaver, isNightTime, resolvePhotoDirectory } from '../server/screensaver.js';

test('screensaver scant recursief ondersteunde fototypes zonder paden te lekken', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dashboard-photos-'));
  try {
    await mkdir(join(root, 'vakantie', 'dag 1'), { recursive: true });
    await writeFile(join(root, 'vakantie', 'dag 1', 'strand.JPEG'), 'jpeg');
    await writeFile(join(root, 'portret.png'), 'png');
    await writeFile(join(root, 'heic.HEIC'), 'heic');
    await writeFile(join(root, 'video.mp4'), 'video');
    const saver = createScreensaver({ photoDirectory: root, dataDirectory: join(root, 'cache') });
    const photos = await saver.scan();
    assert.equal(photos.length, 3);
    assert.ok(photos.every(photo => /^[a-f0-9]{32}$/.test(photo.id) && photo.url === `/api/screensaver/image/${photo.id}`));
    assert.ok(photos.every(photo => !JSON.stringify(photo).includes(root)));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('screensaver geeft een missende foto als 404 terug', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dashboard-photos-'));
  try {
    const saver = createScreensaver({ photoDirectory: root, dataDirectory: join(root, 'cache') });
    await assert.rejects(saver.convert('../private'), error => error.statusCode === 404);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('screensaver maakt ontbrekende HEIC-converter duidelijk zonder padinformatie', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dashboard-photos-'));
  try {
    await writeFile(join(root, 'photo.heic'), 'fake HEIC');
    const saver = createScreensaver({ photoDirectory: root, dataDirectory: join(root, 'cache'), heifConvert: join(root, 'missing-heif-convert') });
    const [photo] = await saver.scan();
    await assert.rejects(saver.convert(photo.id), error => error.statusCode === 503 && /heif-convert beschikbaar is in PATH/.test(error.publicMessage));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('nachtvenster werkt over middernacht in Europe/Amsterdam', () => {
  const window = { startTime: '23:00', endTime: '07:00', timezone: 'Europe/Amsterdam' };
  assert.equal(isNightTime(new Date('2026-01-15T22:30:00Z'), window), true); // 23:30 CET
  assert.equal(isNightTime(new Date('2026-01-15T05:59:00Z'), window), true); // 06:59 CET
  assert.equal(isNightTime(new Date('2026-01-15T06:00:00Z'), window), false); // 07:00 CET
  assert.equal(isNightTime(new Date('2026-01-15T12:00:00Z'), window), false);
});

test('standaard fotomap past zich aan lokaal starten en Docker aan', () => {
  assert.equal(resolvePhotoDirectory('/app/photos', '/workspace/dashboard'), '/workspace/dashboard/photos');
  assert.equal(resolvePhotoDirectory('/app/photos', '/app'), '/app/photos');
  assert.equal(resolvePhotoDirectory('/mnt/shared/photos', '/workspace/dashboard'), '/mnt/shared/photos');
});
