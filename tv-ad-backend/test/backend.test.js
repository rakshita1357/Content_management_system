import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { createPublicReader } from '../src/drive/publicReader.js';
import { createTokenProvider } from '../src/drive/oauth.js';
import { createDriveWriter } from '../src/drive/writer.js';
import { createStateStore } from '../src/lib/stateStore.js';
import { createSyncService } from '../src/services/syncService.js';
import { createUploadService } from '../src/services/uploadService.js';
import { createSourceService } from '../src/services/sourceService.js';
import { parseFolderInput } from '../src/drive/parseFolderLink.js';
import { startFakeGoogle } from './fakeGoogle.js';
import { ROOT_ID, sampleDrive } from './fixtures.js';

const quiet = { info() {}, error() {} };
const AUTH = { Authorization: `Basic ${Buffer.from('admin:secret').toString('base64')}` };

async function setup({ apiKey = 'good-key', withOAuth = true, publicVisible = true, publish = true, folderId = ROOT_ID, readOnly = false, extraEnv = {} } = {}) {
  const drive = sampleDrive();
  const google = await startFakeGoogle({ apiKey: 'good-key', root: drive.root, children: drive.children, rootId: ROOT_ID, publicVisible, readOnly });
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tvads-'));
  const config = loadConfig({
    DRIVE_FOLDER_ID: folderId, DRIVE_API_KEY: apiKey, PUBLISH_TO_DRIVE: publish ? 'true' : 'false', ...extraEnv, ADMIN_PASSWORD: 'secret', MAX_UPLOAD_MB: '1', DATA_DIR: dataDir,
    GOOGLE_CLIENT_ID: withOAuth ? 'id' : '', GOOGLE_CLIENT_SECRET: withOAuth ? 'sec' : '', GOOGLE_REFRESH_TOKEN: withOAuth ? 'rt' : '',
    DRIVE_API_BASE: `${google.base}/drive/v3`, DRIVE_UPLOAD_BASE: `${google.base}/upload/drive/v3`, GOOGLE_TOKEN_URL: `${google.base}/token`,
  });
  const tokens = createTokenProvider(config);
  const writer = tokens.isConfigured() ? createDriveWriter(config, tokens) : null;
  const reader = createPublicReader(config, tokens);
  const sync = createSyncService({ config, reader, writer, store: createStateStore(dataDir), log: quiet });
  await sync.init();
  const app = createApp({ config, sync, uploads: createUploadService({ config, writer, sync }), sources: createSourceService({ reader, sync }), reader, log: quiet });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  const close = async () => { app.close(); google.server.close(); await rm(dataDir, { recursive: true, force: true }); };
  return { google, sync, base, close, dataDir, config, reader, writer };
}

const fileByName = (google, name) => [...google.files.values()].find((f) => f.name === name);

test('admin API requires login', async (t) => {
  const env = await setup(); t.after(env.close);
  assert.equal((await fetch(`${env.base}/api/status`)).status, 401);
  assert.equal((await fetch(`${env.base}/healthz`)).status, 200);
  assert.equal((await fetch(`${env.base}/api/status`, { headers: AUTH })).status, 200);
});

test('sync publishes ads.json to Drive, then skips unchanged content', async (t) => {
  const env = await setup(); t.after(env.close);
  const first = await env.sync.sync();
  assert.equal(first.published, true);
  const manifest = JSON.parse(env.google.bodies.get(fileByName(env.google, 'ads.json').id));
  assert.equal(manifest.ads.length, 3);
  const second = await env.sync.sync();
  assert.equal(second.published, false);
  assert.equal(second.changed, false);
});

test('upload streams to a new ad folder and republishes', async (t) => {
  const env = await setup(); t.after(env.close);
  await env.sync.sync();
  const payload = Buffer.alloc(200_000, 7);
  const res = await fetch(`${env.base}/api/upload?adName=${encodeURIComponent("Chef's special")}&fileName=promo.mp4`, {
    method: 'PUT', headers: { ...AUTH, 'Content-Type': 'video/mp4' }, body: payload,
  });
  const body = await res.json();
  assert.equal(res.status, 201, JSON.stringify(body));
  assert.equal(body.folderCreated, true);
  assert.equal(body.sync.published, true);
  assert.equal(body.sync.totalAds, 4);
  const ads = (await (await fetch(`${env.base}/preview/ads.json`, { headers: AUTH })).json()).ads;
  assert.equal(ads.at(-1).fileName, 'promo.mp4');
  assert.equal(ads.at(-1).adName, "Chef's special");

  // Second upload into the same ad reuses the folder.
  const again = await fetch(`${env.base}/api/upload?adName=${encodeURIComponent("Chef's special")}&fileName=b.png`, {
    method: 'PUT', headers: { ...AUTH, 'Content-Type': 'image/png' }, body: Buffer.alloc(10),
  });
  assert.equal((await again.json()).folderCreated, false);
});

test('upload rejects wrong types and oversize files with a clear message', async (t) => {
  const env = await setup(); t.after(env.close);
  const bad = await fetch(`${env.base}/api/upload?adName=X&fileName=a.gif`, { method: 'PUT', headers: { ...AUTH, 'Content-Type': 'image/gif' }, body: Buffer.alloc(10) });
  assert.equal(bad.status, 415);
  assert.match((await bad.json()).error, /MP4/);
  const big = await fetch(`${env.base}/api/upload?adName=X&fileName=a.mp4`, { method: 'PUT', headers: { ...AUTH, 'Content-Type': 'video/mp4' }, body: Buffer.alloc(2 * 1048576) });
  assert.equal(big.status, 413);
  assert.match((await big.json()).hint, /1080p/);
});

test('without OAuth: scanning works, publishing and uploads are off', async (t) => {
  const env = await setup({ withOAuth: false }); t.after(env.close);
  const result = await env.sync.sync();
  assert.equal(result.published, false);
  const status = await (await fetch(`${env.base}/api/status`, { headers: AUTH })).json();
  assert.equal(status.publishing.enabled, false);
  const up = await fetch(`${env.base}/api/upload?adName=X&fileName=a.mp4`, { method: 'PUT', headers: { ...AUTH, 'Content-Type': 'video/mp4' }, body: Buffer.alloc(10) });
  assert.equal(up.status, 503);
});

test('a bad API key surfaces a fix-it hint in status', async (t) => {
  const env = await setup({ apiKey: 'wrong', withOAuth: false }); t.after(env.close);
  await assert.rejects(env.sync.sync());
  const status = await (await fetch(`${env.base}/api/status`, { headers: AUTH })).json();
  assert.match(status.lastError.hint, /DRIVE_API_KEY/);
});

test('published revision survives a restart (no needless re-upload)', async (t) => {
  const env = await setup(); t.after(env.close);
  await env.sync.sync();
  const store = createStateStore(env.dataDir);
  assert.equal((await store.load()).publishedRevision, env.sync.getStatus().publishedRevision);
});

test('private folder: scan runs as the signed-in account, so ads are found and no sharing warning is shown', async (t) => {
  const env = await setup({ publicVisible: false }); t.after(env.close);
  const result = await env.sync.sync();
  assert.equal(result.totalAds, 3);
  assert.equal(result.published, true);
  assert.equal(env.sync.getStatus().warning, null);
});

test('Drive publishing is off by default: ads are scanned but ads.json/index.html are not written', async (t) => {
  const env = await setup({ publish: false }); t.after(env.close);
  const result = await env.sync.sync();
  assert.equal(result.totalAds, 3);
  assert.equal(result.published, false);
  assert.equal(env.google.bodies.size, 0, 'nothing was written to Drive');
  assert.equal(env.sync.getStatus().publishing.reason, null);
});

test('a failed Drive publish is a warning, not a failed sync', async (t) => {
  const env = await setup(); t.after(env.close);
  env.google.server.denyWrites = true; // like a view-only folder
  const result = await env.sync.sync();
  assert.equal(result.totalAds, 3);
  assert.equal(result.published, false);
  assert.match(env.sync.getStatus().warning, /Playback is not affected/);
  assert.equal(env.sync.getStatus().lastError, null);
});

test('config: DRIVE_API_KEY is optional with OAuth, required without it', () => {
  const base = { DRIVE_FOLDER_ID: ROOT_ID };
  const oauth = { GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b', GOOGLE_REFRESH_TOKEN: 'c' };
  assert.doesNotThrow(() => loadConfig({ ...base, ...oauth }));
  assert.doesNotThrow(() => loadConfig({ ...base, DRIVE_API_KEY: 'k' }));
  assert.throws(() => loadConfig(base), /OAuth/);
  assert.equal(loadConfig({ ...base, ...oauth }).publishToDrive, false);
});

test('public manifest hides the Drive folder id; the admin copy keeps it', async (t) => {
  const env = await setup(); t.after(env.close);
  await env.sync.sync();
  const pub = await (await fetch(`${env.base}/tv/ads.json`)).text();
  assert.doesNotMatch(pub, new RegExp(ROOT_ID));
  const admin = await (await fetch(`${env.base}/preview/ads.json`, { headers: AUTH })).json();
  assert.equal(admin.source.folderId, ROOT_ID);
});

test('without OAuth, a private folder still scans as 0 ads (key-only reader)', async (t) => {
  const env = await setup({ publicVisible: false, withOAuth: false }); t.after(env.close);
  assert.equal((await env.sync.sync()).totalAds, 0);
});

test('end to end on a private folder: upload anime/ad1.jpg appears in Run order and ads.json', async (t) => {
  const env = await setup({ publicVisible: false }); t.after(env.close);
  await env.sync.sync();
  const up = await fetch(`${env.base}/api/upload?adName=anime&fileName=ad1.jpg`, { method: 'PUT', headers: { ...AUTH, 'Content-Type': 'image/jpeg' }, body: Buffer.alloc(500, 1) });
  assert.equal(up.status, 201);
  const ad = (await (await fetch(`${env.base}/api/ads`, { headers: AUTH })).json()).ads.find((a) => a.fileName === 'ad1.jpg');
  assert.equal(ad.adName, 'anime');
  assert.equal(ad.type, 'image');
  assert.equal(ad.durationSec, 60);
  const published = JSON.parse(env.google.bodies.get(fileByName(env.google, 'ads.json').id));
  assert.ok(published.ads.some((a) => a.adName === 'anime' && a.fileName === 'ad1.jpg'));
});

test('TV routes need no login: /tv page, /tv/ads.json, health', async (t) => {
  const env = await setup(); t.after(env.close);
  await env.sync.sync();
  const page = await fetch(`${env.base}/tv`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /id="player-root"/);
  assert.match(html, /id="start"/);
  const m = await (await fetch(`${env.base}/tv/ads.json`)).json();
  assert.equal(m.ads.length, 3);
  assert.equal((await fetch(`${env.base}/api/health`)).status, 200);
  // admin-only routes still need login
  assert.equal((await fetch(`${env.base}/api/ads`)).status, 401);
  assert.equal((await fetch(`${env.base}/api/sync`, { method: 'POST' })).status, 401);
});

test('media is streamed through the backend with Range support, only for ads in ads.json', async (t) => {
  const env = await setup({ publicVisible: false }); t.after(env.close);
  await env.sync.sync();
  const bytes = Buffer.from('0123456789'.repeat(100));
  env.google.media.set('vid1', bytes);
  const full = await fetch(`${env.base}/api/ads/vid1/content`);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'video/mp4');
  assert.equal(Buffer.from(await full.arrayBuffer()).length, 1000);
  const part = await fetch(`${env.base}/api/ads/vid1/content`, { headers: { Range: 'bytes=10-19' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 10-19/1000');
  assert.equal(Buffer.from(await part.arrayBuffer()).toString(), '0123456789');
  // an id that is not in ads.json is never proxied
  assert.equal((await fetch(`${env.base}/api/ads/not-an-ad/content`)).status, 404);
  // no Google credentials in anything the TV can read
  const m = await (await fetch(`${env.base}/tv/ads.json`)).text();
  assert.doesNotMatch(m, /googleapis|key=|Bearer/);
});

test('GET /api/ads/:id returns one ad (admin login)', async (t) => {
  const env = await setup(); t.after(env.close);
  await env.sync.sync();
  const ad = await (await fetch(`${env.base}/api/ads/img1`, { headers: AUTH })).json();
  assert.equal(ad.fileName, 'poster.jpg');
  assert.equal((await fetch(`${env.base}/api/ads/img1`)).status, 401);
});

const post = (env, path, body) => fetch(`${env.base}${path}`, { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const FOLDER_LINK = (id) => `https://drive.google.com/drive/folders/${id}?usp=sharing`;

test('parseFolderInput accepts common link shapes and rejects the rest with a clear message', () => {
  const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz_-12';
  assert.equal(parseFolderInput(`https://drive.google.com/drive/folders/${ID}`), ID);
  assert.equal(parseFolderInput(`https://drive.google.com/drive/folders/${ID}?usp=sharing`), ID);
  assert.equal(parseFolderInput(`https://drive.google.com/drive/u/2/folders/${ID}`), ID);
  assert.equal(parseFolderInput(`  drive.google.com/drive/folders/${ID}  `), ID);
  assert.equal(parseFolderInput(`https://drive.google.com/open?id=${ID}`), ID);
  assert.equal(parseFolderInput(`https://drive.google.com/folderview?id=${ID}&usp=sharing`), ID);
  assert.equal(parseFolderInput(ID), ID);
  assert.throws(() => parseFolderInput(''), /Paste/);
  assert.throws(() => parseFolderInput(`https://drive.google.com/file/d/${ID}/view`), /single file/);
  assert.throws(() => parseFolderInput(`https://example.com/drive/folders/${ID}`), /not a Google Drive link/);
  assert.throws(() => parseFolderInput('https://drive.google.com/drive/my-drive'), /Could not find a folder/);
  assert.throws(() => parseFolderInput('not a link at all'), /link/);
});

test('first run: no folder yet, nothing to scan, /tv/ads.json says so, then pasting a link loads the ads', async (t) => {
  const env = await setup({ folderId: '' }); t.after(env.close);
  assert.equal(env.sync.getStatus().needsSetup, true);
  assert.equal((await env.sync.sync()).needsSetup, true);
  const waiting = await fetch(`${env.base}/tv/ads.json`);
  assert.equal(waiting.status, 503);
  assert.match((await waiting.json()).error, /No Drive folder is connected/);
  assert.equal((await fetch(`${env.base}/tv/`)).status, 200, 'the page itself always loads and shows the message');

  const res = await post(env, '/api/source', { link: FOLDER_LINK(ROOT_ID) });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.source.folderName, 'Test root');
  assert.equal(body.source.canWrite, true);
  assert.equal(body.summary.totalAds, 3);
  assert.equal(body.sync.totalAds, 3);
  assert.ok(body.warnings.some((w) => /ignored/.test(w)), 'root-level files are called out');
  assert.equal(env.sync.getStatus().needsSetup, false);
  assert.equal((await fetch(`${env.base}/tv/ads.json`)).status, 200);
});

test('the chosen folder is remembered across a restart and wins over .env', async (t) => {
  const env = await setup({ folderId: '' }); t.after(env.close);
  await post(env, '/api/source', { link: FOLDER_LINK(ROOT_ID) });
  const again = createSyncService({ config: loadConfig({ DRIVE_FOLDER_ID: 'OLD_FOLDER_FROM_ENV_123', DRIVE_API_KEY: 'k', DATA_DIR: env.dataDir }), reader: env.reader, writer: env.writer, store: createStateStore(env.dataDir), log: quiet });
  await again.init();
  assert.equal(again.getSource().folderId, ROOT_ID);
});

test('bad links and unreachable folders are rejected with a reason and change nothing', async (t) => {
  const env = await setup(); t.after(env.close);
  const file = await post(env, '/api/source', { link: 'https://drive.google.com/file/d/ABCDEFGHIJKLMNOP/view' });
  assert.equal(file.status, 400);
  assert.match((await file.json()).error, /single file/);
  const missing = await post(env, '/api/source', { link: FOLDER_LINK('DOES_NOT_EXIST_123456') });
  assert.equal(missing.status, 404);
  assert.match((await missing.json()).hint, /shared with the Google account/);
  env.google.files.set('SOME_VIDEO_FILE_12345', { id: 'SOME_VIDEO_FILE_12345', name: 'x.mp4', mimeType: 'video/mp4', parents: [ROOT_ID], trashed: false });
  const notFolder = await post(env, '/api/source', { link: FOLDER_LINK('SOME_VIDEO_FILE_12345') });
  assert.equal(notFolder.status, 400);
  assert.match((await notFolder.json()).error, /is a file, not a folder/);
  assert.equal(env.sync.getSource().folderId, ROOT_ID);
  assert.equal((await post(env, '/api/source', {})).status, 400);
  assert.equal((await fetch(`${env.base}/api/source`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
});

test('switching folders replaces the ads and the old run order is gone', async (t) => {
  const env = await setup(); t.after(env.close);
  await env.sync.sync();
  env.google.files.set('SECOND_FOLDER_1234567', { id: 'SECOND_FOLDER_1234567', name: 'Second', mimeType: 'application/vnd.google-apps.folder', parents: [ROOT_ID], trashed: false });
  env.google.files.set('SECOND_AD_FILE_123456', { id: 'SECOND_AD_FILE_123456', name: 'only.png', mimeType: 'image/png', size: '10', createdTime: '2026-09-09T00:00:00Z', modifiedTime: '2026-09-09T00:00:00Z', parents: ['SECOND_FOLDER_1234567'], trashed: false });
  // SECOND_FOLDER is itself a folder whose child "only.png" sits directly inside it, so it has no ad subfolders.
  const res = await post(env, '/api/source', { link: FOLDER_LINK('SECOND_FOLDER_1234567') });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.summary.totalAds, 0);
  assert.ok(body.warnings.some((w) => /no subfolders/.test(w)));
  assert.equal(env.sync.getManifest().ads.length, 0);
  assert.equal(env.sync.getStatus().source.folderName, 'Second');
});

test('view-only folder: ads are scanned, uploads and Drive publishing are refused politely', async (t) => {
  const env = await setup({ folderId: '', readOnly: true }); t.after(env.close);
  const body = await (await post(env, '/api/source', { link: ROOT_ID })).json();
  assert.equal(body.source.canWrite, false);
  assert.equal(body.summary.totalAds, 3);
  assert.equal(body.sync.published, false);
  const up = await fetch(`${env.base}/api/upload?adName=X&fileName=a.png`, { method: 'PUT', headers: { ...AUTH, 'Content-Type': 'image/png' }, body: Buffer.alloc(10) });
  assert.equal(up.status, 403);
  assert.match((await up.json()).error, /view-only/);
});

test('upload before any folder is connected explains what to do', async (t) => {
  const env = await setup({ folderId: '' }); t.after(env.close);
  const up = await fetch(`${env.base}/api/upload?adName=X&fileName=a.png`, { method: 'PUT', headers: { ...AUTH, 'Content-Type': 'image/png' }, body: Buffer.alloc(10) });
  assert.equal(up.status, 409);
  assert.match((await up.json()).hint, /admin page/);
});

test('the front page is just a link box that posts to /api/source; admin keeps its own page', async (t) => {
  const env = await setup({ folderId: '' }); t.after(env.close);
  assert.equal((await fetch(`${env.base}/`)).status, 401);
  const home = await fetch(`${env.base}/`, { headers: AUTH, redirect: 'manual' });
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.match(html, /id="link"/);
  assert.match(html, /\/api\/source/);
  assert.match(html, /window\.location\.href = '\/tv\/'/);
  const admin = await (await fetch(`${env.base}/admin`, { headers: AUTH })).text();
  assert.match(admin, /Add an ad/);
  assert.doesNotMatch(admin, /source-form/);
});

test('web-core files are served at /tv/, unknown files and path tricks are refused', async (t) => {
  const env = await setup(); t.after(env.close);
  const redirect = await fetch(`${env.base}/tv`, { redirect: 'manual' });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), '/tv/');
  for (const [file, type] of [['', /text\/html/], ['index.html', /text\/html/], ['app.css', /text\/css/], ['player.js', /javascript/], ['config.js', /javascript/], ['cache.js', /javascript/]]) {
    const res = await fetch(`${env.base}/tv/${file}`);
    assert.equal(res.status, 200, file);
    assert.match(res.headers.get('content-type'), type);
  }
  assert.equal((await fetch(`${env.base}/tv/package.json`, { headers: AUTH })).status, 404);
  assert.equal((await fetch(`${env.base}/tv/..%2Fpackage.json`, { headers: AUTH })).status, 404);
  assert.equal((await fetch(`${env.base}/tv/%2e%2e/src/config.js`, { headers: AUTH })).status, 404);
});

test('TV routes allow cross-origin reads (packaged TV apps), admin routes do not', async (t) => {
  const env = await setup(); t.after(env.close);
  await env.sync.sync();
  assert.equal((await fetch(`${env.base}/tv/ads.json`)).headers.get('access-control-allow-origin'), '*');
  env.google.media.set('img1', Buffer.alloc(10));
  assert.equal((await fetch(`${env.base}/api/ads/img1/content`)).headers.get('access-control-allow-origin'), '*');
  assert.equal((await fetch(`${env.base}/api/status`, { headers: AUTH })).headers.get('access-control-allow-origin'), null);
});

// ---- Phase 4: sync hardening ----------------------------------------------------------------

import { nextDelayMs } from '../src/services/syncService.js';
import { diffManifests } from '../src/manifest/buildManifest.js';
import { createGoogleFetch } from '../src/lib/googleFetch.js';

const FAST = { GOOGLE_RETRY_BASE_MS: '5', GOOGLE_TIMEOUT_MS: '300', GOOGLE_RETRIES: '2' };
const setupFast = (opts = {}) => setup({ ...opts, extraEnv: FAST });

test('google calls: repeats server errors, then succeeds', async () => {
  let calls = 0;
  const gf = createGoogleFetch({ timeoutMs: 500, retries: 3, retryBaseMs: 1 }, async () => (++calls < 3 ? new Response('x', { status: 503 }) : new Response('ok')));
  const res = await gf('http://x/');
  assert.equal(await res.text(), 'ok');
  assert.equal(calls, 3);
});

test('google calls: a POST is not repeated unless asked, a hung call times out with a clear error', async () => {
  let calls = 0;
  const gf = createGoogleFetch({ timeoutMs: 50, retries: 3, retryBaseMs: 1 }, async () => { calls++; return new Response('x', { status: 503 }); });
  assert.equal((await gf('http://x/', { method: 'POST' })).status, 503);
  assert.equal(calls, 1);
  const hung = createGoogleFetch({ timeoutMs: 40, retries: 1, retryBaseMs: 1 }, (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))));
  await assert.rejects(hung('http://x/'), (err) => err.status === 502 && /did not answer in time/.test(err.message) && /internet connection/.test(err.hint));
  const down = createGoogleFetch({ timeoutMs: 40, retries: 0, retryBaseMs: 1 }, async () => { throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }); });
  await assert.rejects(down('http://x/'), /Cannot reach Google Drive \(ENOTFOUND\)/);
});

test('sync survives two Drive server errors in a row', async (t) => {
  const env = await setupFast(); t.after(env.close);
  env.google.server.fault = { status: 503, count: 2 };
  const result = await env.sync.sync();
  assert.equal(result.totalAds, 3);
  assert.equal(env.sync.getStatus().failures, 0);
});

test('a hung Drive call fails the sync cleanly and the next sync works (the queue is not stuck)', async (t) => {
  const env = await setupFast(); t.after(env.close);
  env.google.server.hangMs = 2000;
  await assert.rejects(env.sync.sync(), /did not answer in time/);
  assert.equal(env.sync.getStatus().failures, 1);
  assert.match(env.sync.getStatus().lastError.hint, /internet connection/);
  env.google.server.hangMs = 0;
  assert.equal((await env.sync.sync()).totalAds, 3);
  assert.equal(env.sync.getStatus().failures, 0);
});

test('an empty answer from Drive is held back once, then accepted if it repeats', async (t) => {
  const env = await setup(); t.after(env.close);
  await env.sync.sync();
  const kept = env.sync.getManifest().revision;
  env.google.server.emptyLists = true;
  const first = await env.sync.sync();
  assert.equal(first.heldBack, true);
  assert.equal(first.totalAds, 3);
  assert.equal(env.sync.getManifest().revision, kept, 'the TV still gets the previous list');
  assert.match(env.sync.getStatus().warning, /previous list is kept/);
  const second = await env.sync.sync();
  assert.equal(second.totalAds, 0, 'a second empty scan is believed');
  assert.equal(env.sync.getManifest().ads.length, 0);
});

test('"Sync now" trusts an empty folder immediately', async (t) => {
  const env = await setup(); t.after(env.close);
  await env.sync.sync();
  env.google.server.emptyLists = true;
  assert.equal((await env.sync.sync({ reason: 'manual', force: true })).totalAds, 0);
});

test('the last good ad list survives a restart, even when Drive is unreachable', async (t) => {
  const env = await setup(); t.after(env.close);
  await env.sync.sync();
  const revision = env.sync.getManifest().revision;
  // "restart": a new service on the same data folder whose Drive calls all fail
  const dead = createPublicReader(loadConfig({ DRIVE_FOLDER_ID: ROOT_ID, DRIVE_API_KEY: 'k', GOOGLE_RETRIES: '0', GOOGLE_RETRY_BASE_MS: '1', DRIVE_API_BASE: 'http://127.0.0.1:9/drive/v3' }));
  const again = createSyncService({ config: env.config, reader: dead, writer: null, store: createStateStore(env.dataDir), log: quiet });
  await again.init();
  assert.equal(again.getManifest().revision, revision);
  assert.equal(again.getManifest().ads.length, 3);
  assert.equal(again.getStatus().fromDisk, true);
  await assert.rejects(again.sync(), /Cannot reach Google Drive/);
  assert.equal(again.getManifest().ads.length, 3, 'a failed scan never throws the list away');
});

test('the saved list is dropped when the folder is changed', async (t) => {
  const env = await setup(); t.after(env.close);
  await env.sync.sync();
  assert.ok(await createStateStore(env.dataDir).loadManifest());
  await env.sync.setSource({ folderId: 'OTHER_FOLDER_1234567', folderName: 'Other', canWrite: true });
  assert.equal(await createStateStore(env.dataDir).loadManifest(), null);
  assert.equal(env.sync.getManifest(), null);
});

test('retry timing after failures: 30 s, 1 min, 2 min ... never longer than the normal interval', () => {
  assert.equal(nextDelayMs(0, 300), 300_000);
  assert.equal(nextDelayMs(1, 300), 30_000);
  assert.equal(nextDelayMs(2, 300), 60_000);
  assert.equal(nextDelayMs(3, 300), 120_000);
  assert.equal(nextDelayMs(9, 300), 300_000);
  assert.equal(nextDelayMs(1, 30), 30_000);
});

test('changes are described as added / changed / removed and shown in status', async (t) => {
  const a = { ads: [{ id: '1', md5: 'a', sizeBytes: 1, adName: 'x', fileName: 'f' }, { id: '2', md5: 'b', sizeBytes: 1, adName: 'x', fileName: 'g' }, { id: '3', md5: 'c', sizeBytes: 1, adName: 'y', fileName: 'h' }] };
  const b = { ads: [{ id: '1', md5: 'a', sizeBytes: 1, adName: 'x', fileName: 'f' }, { id: '2', md5: 'B2', sizeBytes: 1, adName: 'x', fileName: 'g' }, { id: '4', md5: 'd', sizeBytes: 1, adName: 'y', fileName: 'i' }] };
  assert.deepEqual(diffManifests(a, b), { added: 1, modified: 1, removed: 1 });
  assert.deepEqual(diffManifests(a, a), { added: 0, modified: 0, removed: 0 });

  const env = await setup(); t.after(env.close);
  await env.sync.sync();
  assert.equal(env.sync.getStatus().lastChange, null, 'the first scan is not a "change"');
  env.google.files.get('img1').trashed = true;
  await env.sync.sync();
  const change = env.sync.getStatus().lastChange;
  assert.equal(change.removed, 1);
  assert.equal(change.added, 0);
});

test('health reports sync state without exposing details; three failures in a row flag it', async (t) => {
  const env = await setupFast(); t.after(env.close);
  await env.sync.sync();
  let health = await (await fetch(`${env.base}/api/health`)).json();
  assert.deepEqual(Object.keys(health).sort(), ['ads', 'lastSuccessAt', 'needsSetup', 'ok', 'revision', 'syncOk']);
  assert.equal(health.ads, 3);
  assert.equal(health.syncOk, true);
  env.google.server.fault = { status: 500, count: 1000 };
  for (let i = 0; i < 3; i++) await env.sync.sync().catch(() => {});
  health = await (await fetch(`${env.base}/api/health`)).json();
  assert.equal(health.ok, true, 'the backend itself is up');
  assert.equal(health.syncOk, false);
  assert.equal(env.sync.getManifest().ads.length, 3, 'ads keep being served while Drive is failing');
  assert.equal((await fetch(`${env.base}/tv/ads.json`)).status, 200);
});
