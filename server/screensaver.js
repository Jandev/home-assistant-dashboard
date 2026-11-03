import { createHash } from 'node:crypto';
import { readdir, mkdir, stat, rename, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { extname, join, resolve, sep } from 'node:path';

const supported = new Set(['.jpg', '.jpeg', '.png', '.heic']);

export function isNightTime(date, { startTime = '23:00', endTime = '07:00', timezone = 'Europe/Amsterdam' } = {}) {
  const current = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
  const minute = value => { const [hour, min] = value.split(':').map(Number); return hour * 60 + min; };
  const now = minute(current), start = minute(startTime), end = minute(endTime);
  return start > end ? now >= start || now < end : now >= start && now < end;
}

export function resolvePhotoDirectory(configured = '/app/photos', workingDirectory = process.cwd()) {
  return configured === '/app/photos' && resolve(workingDirectory) !== '/app'
    ? resolve(workingDirectory, 'photos')
    : configured;
}

export function createScreensaver({ photoDirectory = '/app/photos', dataDirectory = '/app/data', ffmpeg = 'ffmpeg', heifConvert = 'heif-convert', logger = console } = {}) {
  const photos = new Map();
  const flights = new Map();
  const root = resolve(photoDirectory);
  const cache = resolve(dataDirectory, 'screensaver-cache');
  let emptyDirectoryLogged = false;

  function logFailure(operation, error, { photoId, stage } = {}) {
    logger.error?.('[screensaver] Operation failed', {
      operation,
      stage: stage || error.screensaverStage || operation,
      code: error.code || 'UNKNOWN',
      ...(photoId ? { photoId } : {})
    });
  }

  function runConverter(command, args, { missing, failed, stage }) {
    return new Promise((resolvePromise, reject) => {
      const process = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      process.stderr.setEncoding('utf8');
      process.stderr.on('data', chunk => { if (stderr.length < 4096) stderr += chunk.slice(0, 4096 - stderr.length); });
      process.once('error', error => reject(Object.assign(new Error(error.message), {
        statusCode: error.code === 'ENOENT' ? 503 : 502,
        publicMessage: error.code === 'ENOENT' ? missing : failed,
        code: error.code,
        screensaverStage: stage
      })));
      process.once('close', code => {
        if (code === 0) return resolvePromise();
        const accessDenied = /permission denied|operation not permitted|access denied/i.test(stderr);
        reject(Object.assign(new Error(failed), {
          statusCode: 502,
          publicMessage: failed,
          code: accessDenied ? 'EACCES' : `EXIT_${code}`,
          screensaverStage: stage
        }));
      });
    });
  }

  async function scan() {
    photos.clear();
    async function walk(directory) {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
      for (const entry of entries) {
        const file = join(directory, entry.name);
        if (entry.isDirectory()) await walk(file);
        else if (entry.isFile() && supported.has(extname(entry.name).toLowerCase())) {
          const info = await stat(file).catch(error => {
            if (error.code !== 'ENOENT') logFailure('scan', error, { stage: 'photo-stat' });
            return null;
          });
          if (!info?.isFile()) continue;
          const relative = file.slice(root.length + (root.endsWith(sep) ? 0 : 1));
          const id = createHash('sha256').update(relative).update(':').update(String(info.size)).update(':').update(String(info.mtimeMs)).digest('hex').slice(0, 32);
          photos.set(id, { id, file, size: info.size });
        }
      }
    }
    try {
      await walk(root);
    } catch (error) {
      logFailure('scan', error, { stage: error.syscall === 'scandir' ? 'photo-directory-read' : 'photo-index' });
      throw error;
    }
    if (photos.size === 0 && !emptyDirectoryLogged) {
      logger.warn?.('[screensaver] No supported photos found in the mounted photo directory');
      emptyDirectoryLogged = true;
    } else if (photos.size > 0) emptyDirectoryLogged = false;
    return [...photos.values()].map(({ id }) => ({ id, url: `/api/screensaver/image/${id}` }));
  }

  async function convert(id) {
    const photo = photos.get(id);
    if (!photo || !/^[a-f0-9]{32}$/.test(id)) throw Object.assign(new Error('Foto niet gevonden'), { statusCode: 404 });
    const output = join(cache, `${id}.jpg`);
    if ((await stat(output).catch(() => null))?.isFile()) return output;
    if (flights.has(id)) return flights.get(id);
    const task = (async () => {
      let stage = 'cache-directory';
      const temporary = join(cache, `${id}.${process.pid}.${Date.now()}.tmp.jpg`);
      const heicTemporary = join(cache, `${id}.${process.pid}.${Date.now()}.tmp.png`);
      try {
        await mkdir(cache, { recursive: true });
        let input = photo.file;
        if (extname(photo.file).toLowerCase() === '.heic') {
          stage = 'heic-convert';
          await runConverter(heifConvert, [photo.file, heicTemporary], {
            missing: 'HEIC-converter ontbreekt. Zorg dat heif-convert beschikbaar is in PATH.',
            failed: 'HEIC-conversie is mislukt. Controleer of het bestand een geldige HEIC-foto is.',
            stage: 'heic-convert'
          });
          input = heicTemporary;
        }
        stage = 'ffmpeg';
        await runConverter(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', input, '-map', '0:v:0', '-frames:v', '1', '-vf', 'scale=1920:1200:force_original_aspect_ratio=decrease:force_divisible_by=2', '-q:v', '4', '-map_metadata', '-1', temporary], {
          missing: 'FFmpeg ontbreekt. Zorg dat ffmpeg beschikbaar is in PATH.',
          failed: 'Foto-optimalisatie is mislukt. Controleer het afbeeldingsbestand.',
          stage: 'ffmpeg'
        });
        stage = 'verify-output';
        if (!(await stat(temporary).catch(() => null))?.isFile()) throw new Error('Image conversion produced no file');
        stage = 'cache-publish';
        await rename(temporary, output);
      } catch (error) {
        error.screensaverStage ||= stage;
        logFailure('render', error, { photoId: id, stage: error.screensaverStage || 'cache-or-conversion' });
        await unlink(temporary).catch(() => {});
        throw error;
      } finally {
        await unlink(heicTemporary).catch(() => {});
      }
      return output;
    })().finally(() => flights.delete(id));
    flights.set(id, task);
    return task;
  }

  return { scan, convert, logFailure };
}
