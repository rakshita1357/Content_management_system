// Browser test harness: a fake Google Drive, the real backend, a "TV app" origin that serves web-core on its own
// (like a packaged Android TV / webOS app, so the page can load even when the backend is down), and headless Chromium.
// Needs Playwright (not a project dependency): set PLAYWRIGHT_MODULE=/path/to/playwright, or install it. Tests skip without it.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/config.js';
import { createApp } from '../../src/app.js';
import { createPublicReader } from '../../src/drive/publicReader.js';
import { createTokenProvider } from '../../src/drive/oauth.js';
import { createDriveWriter } from '../../src/drive/writer.js';
import { createStateStore } from '../../src/lib/stateStore.js';
import { createSyncService } from '../../src/services/syncService.js';
import { createUploadService } from '../../src/services/uploadService.js';
import { createSourceService } from '../../src/services/sourceService.js';
import { startFakeGoogle } from '../fakeGoogle.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_CORE = path.resolve(here, '../../../web-core');
export const ROOT_ID = 'DRIVE_A_ROOT_FOLDER_1234';
export const FOLDER = 'application/vnd.google-apps.folder';
export const WEB_CORE_DIR = WEB_CORE;

export function loadPlaywright() {
  const require = createRequire(import.meta.url);
  for (const c of [process.env.PLAYWRIGHT_MODULE, 'playwright', '/node-tools/node_modules/playwright'].filter(Boolean)) {
    try { return require(c); } catch { /* try the next place */ }
  }
  return null;
}

export function hasFfmpeg() {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

// Small real media files, made once per run.
let media;
export function mediaFiles() {
  if (media) return media;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvmedia-'));
  const make = (name, args) => { execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args, path.join(dir, name)]); return fs.readFileSync(path.join(dir, name)); };
  const color = (c, extra) => ['-f', 'lavfi', '-i', `color=c=${c}:s=320x180${extra || ''}`];
  media = {
    jpg: (c) => make(`${c}.jpg`, [...color(c), '-frames:v', '1']),
    png: (c) => make(`${c}.png`, [...color(c), '-frames:v', '1']),
    mp4: (c, sec = 3) => make(`${c}.mp4`, [...color(c, `:d=${sec}`), '-f', 'lavfi', '-i', 'anullsrc', '-t', String(sec), '-c:v', 'libvpx-vp9', '-c:a', 'aac', '-shortest']),
  };
  return media;
}

// Drive A: three ads in one ad folder.  Drive B: two other ads (a different folder).
export function buildDrive(google) {
  const m = mediaFiles();
  const add = (id, name, mimeType, bytes, parent, extra = {}) => {
    google.files.set(id, { id, name, mimeType, size: String(bytes.length), md5Checksum: `md5-${id}`, createdTime: extra.t || '2026-09-01T10:00:00Z', modifiedTime: extra.t || '2026-09-01T10:00:00Z', parents: [parent], trashed: false });
    google.media.set(id, bytes);
  };
  const folder = (id, name, parent) => google.files.set(id, { id, name, mimeType: FOLDER, parents: [parent], trashed: false, createdTime: '2026-09-01T09:00:00Z' });
  folder('A_ADS_FOLDER_123456', 'Summer', ROOT_ID);
  add('A_AD1_FILE_1234567', 'ad1.jpg', 'image/jpeg', m.jpg('blue'), 'A_ADS_FOLDER_123456', { t: '2026-09-01T10:00:01Z' });
  add('A_AD2_FILE_1234567', 'ad2.mp4', 'video/mp4', m.mp4('red'), 'A_ADS_FOLDER_123456', { t: '2026-09-01T10:00:02Z' });
  add('A_AD3_FILE_1234567', 'ad3.png', 'image/png', m.png('green'), 'A_ADS_FOLDER_123456', { t: '2026-09-01T10:00:03Z' });
  folder('DRIVE_B_ROOT_FOLDER_12', 'Drive B', ROOT_ID);
  folder('B_ADS_FOLDER_123456', 'Winter', 'DRIVE_B_ROOT_FOLDER_12');
  add('B_AD1_FILE_1234567', 'b1.png', 'image/png', m.png('yellow'), 'B_ADS_FOLDER_123456', { t: '2026-09-02T10:00:01Z' });
  add('B_AD2_FILE_1234567', 'b2.jpg', 'image/jpeg', m.jpg('white'), 'B_ADS_FOLDER_123456', { t: '2026-09-02T10:00:02Z' });
  folder('EMPTY_DRIVE_FOLDER_12', 'Empty one', ROOT_ID);
  return { add, folder };
}

export async function startBackend({ google, dataDir, port = 0, source = null, imageSec = 2, syncSec = 30, webCoreDir = '' }) {
  const config = loadConfig({
    DRIVE_API_KEY: 'k', DATA_DIR: dataDir, IMAGE_DURATION_SEC: String(imageSec), SYNC_INTERVAL_SEC: String(syncSec),
    GOOGLE_CLIENT_ID: 'i', GOOGLE_CLIENT_SECRET: 's', GOOGLE_REFRESH_TOKEN: 'r', PORT: String(port || 8080),
    GOOGLE_RETRIES: '0', GOOGLE_RETRY_BASE_MS: '5', GOOGLE_TIMEOUT_MS: '2000',
    DRIVE_API_BASE: `${google.base}/drive/v3`, DRIVE_UPLOAD_BASE: `${google.base}/upload/drive/v3`, GOOGLE_TOKEN_URL: `${google.base}/token`,
    ...(source ? { DRIVE_FOLDER_ID: source } : {}),
    ...(webCoreDir ? { WEB_CORE_DIR: webCoreDir } : {}),
  });
  const tokens = createTokenProvider(config);
  const writer = createDriveWriter(config, tokens);
  const reader = createPublicReader(config, tokens);
  const quiet = { info() {}, error() {} };
  const store = createStateStore(dataDir);
  const sync = createSyncService({ config, reader, writer, store, log: quiet });
  await sync.init();
  const app = createApp({ config, sync, uploads: createUploadService({ config, writer, sync }), sources: createSourceService({ reader, sync }), reader, log: quiet });
  await new Promise((resolve, reject) => { app.once('error', reject); app.listen(port, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${app.address().port}`;
  return {
    app, sync, base, port: app.address().port, store,
    async close() { app.closeAllConnections(); await new Promise((r) => app.close(r)); },
  };
}

// The "installed app": serves web-core by itself with config.js pointing at the backend.
export async function startShell(apiBase, cacheMaxMb = 0) {
  const server = http.createServer((req, res) => {
    const name = req.url === '/' ? 'index.html' : req.url.slice(1).split('?')[0];
    if (!/^[\w.-]+$/.test(name)) { res.writeHead(404); return res.end(); }
    let body;
    if (name === 'config.js') body = `window.TV_CONFIG = { apiBase: '${apiBase}', cacheMaxMb: ${cacheMaxMb} };`;
    else { try { body = fs.readFileSync(path.join(WEB_CORE, name)); } catch { res.writeHead(404); return res.end(); } }
    const type = name.endsWith('.css') ? 'text/css' : name.endsWith('.html') ? 'text/html' : 'application/javascript';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); } };
}

// Everything for one test, torn down afterwards.
export async function createEnv({ source = ROOT_ID, imageSec = 2, cacheMaxMb = 0, webCoreDir = '' } = {}) {
  const pw = loadPlaywright();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvdata-'));
  const sourceInfo = { folderId: ROOT_ID };
  const google = await startFakeGoogle({ apiKey: 'k', root: [], children: new Map(), rootId: ROOT_ID, rootName: 'Drive A' });
  const drive = buildDrive(google);
  let backend = await startBackend({ google, dataDir, source, imageSec, webCoreDir });
  if (source) await backend.sync.sync();
  const shell = await startShell(backend.base, cacheMaxMb);
  const chromePath = process.env.PLAYWRIGHT_CHROMIUM || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
  const browser = await pw.chromium.launch({ executablePath: chromePath });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const env = {
    google, drive, shell, browser, context, dataDir, sourceInfo,
    get backend() { return backend; },
    async restartBackend({ keepDrive = true } = {}) {
      const { port } = backend;
      await backend.close();
      backend = await startBackend({ google, dataDir, port, source: null, imageSec, webCoreDir });
      await backend.sync.init?.();
      return backend;
    },
    async close() {
      await browser.close().catch(() => {});
      await shell.close().catch(() => {});
      await backend.close().catch(() => {});
      await new Promise((r) => { google.server.closeAllConnections?.(); google.server.close(r); });
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
  return env;
}

// Polls an async check from the test side until it is true (page.waitForFunction does not wait for promises).
export async function until(check, { timeout = 20000, every = 150, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, every));
  }
}

// Helpers that run inside the page.
export const page = {
  rows: (p) => p.$$eval('#rows tr', (rs) => rs.map((r) => ({ name: r.querySelector('.c-file')?.textContent, cache: r.querySelector('.c-cache')?.textContent }))),
  saved: (p) => p.$$eval('#rows .c-cache', (cs) => cs.filter((c) => c.textContent === 'Saved').length),
  waitSaved: (p, n, timeout = 20000) => p.waitForFunction((n) => [...document.querySelectorAll('#rows .c-cache')].filter((c) => c.textContent === 'Saved').length === n && document.querySelectorAll('#rows tr').length === n, n, { timeout }),
  // What is in the browser database: the saved files and the committed playlist.
  db: (p) => p.evaluate(() => new Promise((resolve) => {
    const r = indexedDB.open('tvads');
    r.onsuccess = () => {
      const t = r.result.transaction(['media', 'meta']);
      const keys = t.objectStore('media').getAllKeys();
      const meta = t.objectStore('meta').get('committed');
      t.oncomplete = () => { r.result.close(); resolve({ keys: keys.result.sort(), committed: meta.result ? { sourceName: meta.result.sourceName, revision: meta.result.revision, ads: meta.result.manifest.ads.map((a) => a.fileName), committedAt: meta.result.committedAt } : null }); };
    };
    r.onerror = () => resolve({ keys: [], committed: null });
  })),
  playing: (p) => p.evaluate(() => { const s = document.getElementById('stage'); const v = s.querySelector('video'); const i = s.querySelector('img'); const e = v || i; return e ? { kind: v ? 'video' : 'image', cached: e.src.startsWith('blob:'), src: e.src } : null; }),
  start: (p) => p.evaluate(() => window.ADS_PLAYER.start()),
  triggerCheck: (p) => p.evaluate(() => window.dispatchEvent(new Event('online'))),   // same call the 5-minute poll makes
  contentRequests: (p, list) => p.on('request', (r) => { const m = r.url().match(/\/api\/ads\/([^/]+)\/content/); if (m) list.push(m[1]); }),
};
