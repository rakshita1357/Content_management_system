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
import { startFakeGoogle } from './fakeGoogle.js';
import { ROOT_ID, sampleDrive } from './fixtures.js';

const quiet = { info() {}, error() {} };
const AUTH = { Authorization: `Basic ${Buffer.from('admin:secret').toString('base64')}` };

async function setup({ apiKey = 'good-key', withOAuth = true, publicVisible = true } = {}) {
  const drive = sampleDrive();
  const google = await startFakeGoogle({ apiKey: 'good-key', root: drive.root, children: drive.children, rootId: ROOT_ID, publicVisible });
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tvads-'));
  const config = loadConfig({
    DRIVE_FOLDER_ID: ROOT_ID, DRIVE_API_KEY: apiKey, ADMIN_PASSWORD: 'secret', MAX_UPLOAD_MB: '1', DATA_DIR: dataDir,
    GOOGLE_CLIENT_ID: withOAuth ? 'id' : '', GOOGLE_CLIENT_SECRET: withOAuth ? 'sec' : '', GOOGLE_REFRESH_TOKEN: withOAuth ? 'rt' : '',
    DRIVE_API_BASE: `${google.base}/drive/v3`, DRIVE_UPLOAD_BASE: `${google.base}/upload/drive/v3`, GOOGLE_TOKEN_URL: `${google.base}/token`,
  });
  const tokens = createTokenProvider(config);
  const writer = tokens.isConfigured() ? createDriveWriter(config, tokens) : null;
  const reader = createPublicReader(config, tokens);
  const sync = createSyncService({ config, reader, writer, store: createStateStore(dataDir), log: quiet });
  await sync.init();
  const app = createApp({ config, sync, uploads: createUploadService({ config, writer, sync }), reader, log: quiet });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  const close = async () => { app.close(); google.server.close(); await rm(dataDir, { recursive: true, force: true }); };
  return { google, sync, base, close, dataDir };
}

const fileByName = (google, name) => [...google.files.values()].find((f) => f.name === name);

test('admin API requires login', async (t) => {
  const env = await setup(); t.after(env.close);
  assert.equal((await fetch(`${env.base}/api/status`)).status, 401);
  assert.equal((await fetch(`${env.base}/healthz`)).status, 200);
  assert.equal((await fetch(`${env.base}/api/status`, { headers: AUTH })).status, 200);
});

test('sync publishes index.html and ads.json, then skips unchanged content', async (t) => {
  const env = await setup(); t.after(env.close);
  const first = await env.sync.sync();
  assert.equal(first.published, true);
  const manifest = JSON.parse(env.google.bodies.get(fileByName(env.google, 'ads.json').id));
  assert.equal(manifest.ads.length, 3);
  assert.match(env.google.bodies.get(fileByName(env.google, 'index.html').id), /Ad run order/);
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

test('private folder: scan runs as the signed-in account, so ads are found, and status warns the TV cannot see it', async (t) => {
  const env = await setup({ publicVisible: false }); t.after(env.close);
  const result = await env.sync.sync();
  assert.equal(result.totalAds, 3);
  assert.equal(result.published, true);
  const status = await (await fetch(`${env.base}/api/status`, { headers: AUTH })).json();
  assert.match(status.warning, /Anyone with the link/);
});

test('public folder: no warning', async (t) => {
  const env = await setup(); t.after(env.close);
  await env.sync.sync();
  assert.equal(env.sync.getStatus().warning, null);
});

test('without OAuth, a private folder still scans as 0 ads (key-only reader)', async (t) => {
  const env = await setup({ publicVisible: false, withOAuth: false }); t.after(env.close);
  assert.equal((await env.sync.sync()).totalAds, 0);
});

test('end to end on a private folder: upload anime/ad1.jpg appears in Run order, ads.json and index.html', async (t) => {
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
  assert.match(env.google.bodies.get(fileByName(env.google, 'index.html').id), /ad1\.jpg/);
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
