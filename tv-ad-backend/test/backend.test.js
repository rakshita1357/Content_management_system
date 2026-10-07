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

async function setup({ apiKey = 'good-key', withOAuth = true } = {}) {
  const drive = sampleDrive();
  const google = await startFakeGoogle({ apiKey: 'good-key', root: drive.root, children: drive.children, rootId: ROOT_ID });
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'tvads-'));
  const config = loadConfig({
    DRIVE_FOLDER_ID: ROOT_ID, DRIVE_API_KEY: apiKey, ADMIN_PASSWORD: 'secret', MAX_UPLOAD_MB: '1', DATA_DIR: dataDir,
    GOOGLE_CLIENT_ID: withOAuth ? 'id' : '', GOOGLE_CLIENT_SECRET: withOAuth ? 'sec' : '', GOOGLE_REFRESH_TOKEN: withOAuth ? 'rt' : '',
    DRIVE_API_BASE: `${google.base}/drive/v3`, DRIVE_UPLOAD_BASE: `${google.base}/upload/drive/v3`, GOOGLE_TOKEN_URL: `${google.base}/token`,
  });
  const tokens = createTokenProvider(config);
  const writer = tokens.isConfigured() ? createDriveWriter(config, tokens) : null;
  const sync = createSyncService({ config, reader: createPublicReader(config), writer, store: createStateStore(dataDir), log: quiet });
  await sync.init();
  const app = createApp({ config, sync, uploads: createUploadService({ config, writer, sync }), log: quiet });
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
  const env = await setup({ apiKey: 'wrong' }); t.after(env.close);
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
