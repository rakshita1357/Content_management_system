// Pairing codes, a Drive folder per screen, and the folder hub that keeps each folder in sync.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { createPublicReader } from '../src/drive/publicReader.js';
import { createTokenProvider } from '../src/drive/oauth.js';
import { createDriveWriter } from '../src/drive/writer.js';
import { createStateStore } from '../src/lib/stateStore.js';
import { createScreensService } from '../src/services/screensService.js';
import { createPairingService } from '../src/services/pairingService.js';
import { createFolderHub } from '../src/services/folderHub.js';
import { createSyncService } from '../src/services/syncService.js';
import { createUploadService } from '../src/services/uploadService.js';
import { createSourceService } from '../src/services/sourceService.js';
import { startFakeGoogle } from './fakeGoogle.js';
import { FOLDER, ROOT_ID, sampleDrive } from './fixtures.js';

const PASSWORD = 'a-strong-password';
const AUTH = { Authorization: `Basic ${Buffer.from(`admin:${PASSWORD}`).toString('base64')}` };
const link = (id) => `https://drive.google.com/drive/folders/${id}?usp=sharing`;
const TV1 = 'screen-lobby-0001';
const TV2 = 'screen-cafe-00002';
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

async function setup() {
  const drive = sampleDrive();
  const google = await startFakeGoogle({ apiKey: 'k', root: drive.root, children: drive.children, rootId: ROOT_ID });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvp-'));
  const config = loadConfig({
    DRIVE_FOLDER_ID: ROOT_ID, ADMIN_PASSWORD: PASSWORD, DATA_DIR: dataDir, GOOGLE_CLIENT_ID: 'i', GOOGLE_CLIENT_SECRET: 's', GOOGLE_REFRESH_TOKEN: 'r',
    DRIVE_API_BASE: `${google.base}/drive/v3`, DRIVE_UPLOAD_BASE: `${google.base}/upload/drive/v3`, GOOGLE_TOKEN_URL: `${google.base}/token`,
    GOOGLE_RETRIES: '0', SYNC_INTERVAL_SEC: '30',
  });
  const tokens = createTokenProvider(config);
  const reader = createPublicReader(config, tokens);
  const writer = createDriveWriter(config, tokens);
  const store = createStateStore(dataDir);
  const sync = createSyncService({ config, reader, writer, store, log: quiet });
  await sync.init();
  await sync.sync();
  const screens = createScreensService({ persist: (rows) => store.saveScreens(rows) });
  const pairing = createPairingService();
  const hub = createFolderHub({ config, reader, writer, store, mainSync: sync, log: quiet });
  const app = createApp({ config, sync, uploads: createUploadService({ config, writer, sync }), sources: createSourceService({ reader, sync }), reader, screens, pairing, hub, log: quiet });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  const env = { base, google, sync, screens, pairing, hub, store, config, reader, writer, dataDir };
  env.close = async () => { hub.stopAll(); sync.stop(); app.closeAllConnections(); app.close(); google.server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); };
  return env;
}

// A second shop's folder: one ad folder with one image.
const addShop = (env, id, name, files = ['spring.jpg']) => {
  env.google.files.set(id, { id, name, mimeType: FOLDER, parents: [ROOT_ID], trashed: false });
  if (!files.length) return;
  const sub = `${id}_SUB_123456`;
  env.google.files.set(sub, { id: sub, name: 'Spring sale', mimeType: FOLDER, parents: [id], trashed: false, createdTime: '2026-09-09T00:00:00Z' });
  files.forEach((f, i) => {
    const fid = `${id}_FILE_${i}_12345`;
    env.google.files.set(fid, { id: fid, name: f, mimeType: 'image/jpeg', size: '12', md5Checksum: `m${i}`, createdTime: '2026-09-09T00:00:00Z', modifiedTime: '2026-09-09T00:00:00Z', parents: [sub], trashed: false });
    env.google.media.set(fid, Buffer.from(`${name}-bytes-${i}`));
  });
};
const call = (env, method, route, body, headers = AUTH) => fetch(`${env.base}${route}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
const until = async (fn, what) => { for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 50)); } assert.fail(`timed out: ${what}`); };

test('pairing codes: unambiguous, stable until they expire, typed in any style, and capped', () => {
  let t = 1_000_000;
  const pairing = createPairingService({ now: () => t, ttlMs: 60_000, max: 3 });
  const a = pairing.codeFor('tv-a-0000001');
  assert.match(a.code, /^[A-HJKMNP-Z2-9]{6}$/);
  assert.equal(pairing.codeFor('tv-a-0000001').code, a.code, 'the same code while it is valid');
  assert.equal(pairing.lookup(`${a.code.slice(0, 3).toLowerCase()} - ${a.code.slice(3)}`), 'tv-a-0000001', 'case, spaces and dashes do not matter');
  assert.throws(() => pairing.lookup('ZZZZZZ'), /not found or has expired/);
  t += 61_000;
  assert.throws(() => pairing.lookup(a.code), /expired/);
  assert.notEqual(pairing.codeFor('tv-a-0000001').code, a.code, 'a new code after expiry (almost certainly different)');
  pairing.codeFor('tv-b-0000001'); pairing.codeFor('tv-c-0000001');
  assert.throws(() => pairing.codeFor('tv-d-0000001'), /Too many screens/);
});

test('pairing a TV: it shows a code, the admin enters the code and a folder link, and the TV then gets that folder\'s ads', async (t) => {
  const env = await setup(); t.after(env.close);
  addShop(env, 'SHOP_TWO_FOLDER_1234', 'Second shop');

  // a new TV: gets a code, and until it is paired it plays the main folder
  const first = await (await call(env, 'POST', '/tv/pair', { id: TV1 }, {})).json();
  assert.equal(first.assigned, false);
  assert.match(first.code, /^[A-Z2-9]{6}$/);
  const main = await (await fetch(`${env.base}/tv/ads.json?screen=${TV1}`)).json();
  assert.equal(main.summary.totalAds, env.sync.getManifest().ads.length);

  // admin only: assigning
  assert.equal((await call(env, 'POST', '/api/screens/assign', { code: first.code, link: link('SHOP_TWO_FOLDER_1234') }, {})).status, 401);
  assert.equal((await call(env, 'POST', '/api/screens/assign', { code: 'NOPE22', link: link('SHOP_TWO_FOLDER_1234') })).status, 404, 'wrong code');

  const done = await call(env, 'POST', '/api/screens/assign', { code: first.code.toLowerCase(), link: link('SHOP_TWO_FOLDER_1234'), name: 'Lobby TV' });
  assert.equal(done.status, 200);
  const body = await done.json();
  assert.equal(body.folder, 'Second shop');
  assert.equal(body.ads, 1);

  // the TV now gets the second shop's list, another TV still gets the main one
  const mine = await (await fetch(`${env.base}/tv/ads.json?screen=${TV1}`)).json();
  assert.deepEqual(mine.ads.map((a) => a.fileName), ['spring.jpg']);
  assert.equal(mine.source.name, 'Second shop');
  const other = await (await fetch(`${env.base}/tv/ads.json?screen=${TV2}`)).json();
  assert.equal(other.summary.totalAds, env.sync.getManifest().ads.length);
  assert.deepEqual(await (await call(env, 'POST', '/tv/pair', { id: TV1 }, {})).json(), { assigned: true, folderName: 'Second shop', label: 'Lobby TV' });

  // the media of that folder is served, the main folder's still is, an unknown id is not
  const res = await fetch(`${env.base}${mine.ads[0].src}`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'Second shop-bytes-0');
  const mainAd = env.sync.getManifest().ads[0];
  env.google.media.set(mainAd.id, Buffer.from('main-bytes'));
  assert.equal(await (await fetch(`${env.base}${mainAd.src}`)).text(), 'main-bytes');
  assert.equal((await fetch(`${env.base}/api/ads/NOT_A_REAL_ID_12345/content`)).status, 404);

  // the admin list shows the assignment and compares the TV with its own folder's list
  await call(env, 'POST', '/tv/heartbeat', { id: TV1, name: 'tv', revision: mine.revision, folder: 'Second shop', online: true }, {});
  const list = await (await call(env, 'GET', '/api/screens')).json();
  const row = list.screens.find((s) => s.id === TV1);
  assert.equal(row.folderName, 'Second shop');
  assert.equal(row.label, 'Lobby TV');
  assert.equal(row.currentRevision, mine.revision);
  assert.notEqual(row.currentRevision, list.currentRevision);

  // a TV's own "Sync now" syncs its own folder
  assert.equal((await call(env, 'POST', `/tv/sync?screen=${TV1}`, null, {})).status, 200);

  // taking the folder away: back to the main folder
  assert.equal((await call(env, 'POST', '/api/screens/unassign', { id: TV1 })).status, 200);
  const back = await (await fetch(`${env.base}/tv/ads.json?screen=${TV1}`)).json();
  assert.equal(back.summary.totalAds, env.sync.getManifest().ads.length);
  assert.equal((await (await call(env, 'POST', '/tv/pair', { id: TV1 }, {})).json()).assigned, false);
});

test('a folder without ads, a bad link or a bad screen id changes nothing', async (t) => {
  const env = await setup(); t.after(env.close);
  addShop(env, 'EMPTY_SHOP_FOLDER_123', 'Empty shop', []);
  const { code } = await (await call(env, 'POST', '/tv/pair', { id: TV1 }, {})).json();
  const empty = await call(env, 'POST', '/api/screens/assign', { code, link: link('EMPTY_SHOP_FOLDER_123') });
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).code, 'NO_ADS');
  assert.equal((await call(env, 'POST', '/api/screens/assign', { code, link: 'https://example.com/x' })).status, 400);
  assert.equal((await call(env, 'POST', '/api/screens/assign', { code, link: link('DOES_NOT_EXIST_123456') })).status, 404);
  assert.equal((await (await call(env, 'POST', '/tv/pair', { id: TV1 }, {})).json()).assigned, false, 'still not paired, the code still works');
  assert.equal((await call(env, 'POST', '/tv/pair', { id: 'bad id!' }, {})).status, 400);
  assert.equal((await call(env, 'POST', '/api/screens/unassign', { id: 'screen-unknown-0001' })).status, 404);
  // a made-up screen id in the query is ignored: the main folder's list
  assert.equal((await fetch(`${env.base}/tv/ads.json?screen=${encodeURIComponent('x'.repeat(200))}`)).status, 200);
});

test('assignments survive a restart: the folder comes back with its saved ad list straight away', async (t) => {
  const env = await setup(); t.after(env.close);
  addShop(env, 'SHOP_TWO_FOLDER_1234', 'Second shop');
  await call(env, 'POST', '/api/screens/assign', { id: TV1, link: link('SHOP_TWO_FOLDER_1234'), name: 'Lobby TV' });
  assert.equal(env.hub.count(), 1);

  // "restart": new services over the same saved data
  const store = createStateStore(env.dataDir);
  const screens = createScreensService({ persist: (rows) => store.saveScreens(rows) });
  screens.load(await store.loadScreens());
  const row = screens.get(TV1);
  assert.equal(row.folderName, 'Second shop');
  const hub = createFolderHub({ config: env.config, reader: env.reader, writer: env.writer, store, mainSync: env.sync, log: quiet });
  t.after(() => hub.stopAll());
  const sync = await hub.ensure({ folderId: row.folderId, folderName: row.folderName });
  assert.equal(sync.getManifest()?.ads.length, 1, 'the saved list is there at once');
  assert.equal(sync.getStatus().fromDisk, true);
  assert.equal(await hub.ensure({ folderId: row.folderId }), sync, 'one sync per folder');
  assert.equal(hub.findAd(sync.getManifest().ads[0].id)?.fileName, 'spring.jpg');
  await until(() => !sync.getStatus().fromDisk, 'the first scan confirms the list');
});

test('a folder nobody uses any more stops syncing; the main folder is never a separate sync', async (t) => {
  const env = await setup(); t.after(env.close);
  addShop(env, 'SHOP_TWO_FOLDER_1234', 'Second shop');
  await call(env, 'POST', '/api/screens/assign', { id: TV1, link: link('SHOP_TWO_FOLDER_1234') });
  await call(env, 'POST', '/api/screens/assign', { id: TV2, link: link(ROOT_ID) });
  assert.equal(env.hub.count(), 1, 'the main folder is served by the main sync');
  await call(env, 'POST', '/api/screens/unassign', { id: TV1 });
  assert.equal(env.hub.count(), 0);
});
