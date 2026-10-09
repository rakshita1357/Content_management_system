// End-to-end tests for offline play, run in a real (headless) browser against a fake Drive and the real backend.
//   npm run test:browser          (needs Playwright and ffmpeg; the tests skip themselves when either is missing)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnv, hasFfmpeg, loadPlaywright, mediaFiles, page, ROOT_ID, until } from './harness.mjs';

const ready = Boolean(loadPlaywright()) && hasFfmpeg();
const t = (name, fn) => test(name, { skip: ready ? false : 'needs Playwright and ffmpeg', timeout: 90000 }, async (ctx) => {
  const env = await createEnv();
  ctx.after(() => env.close());
  await fn(env, ctx);
});

const open = async (env, origin = 'shell') => {
  const p = await env.context.newPage();
  p.on('pageerror', (e) => assert.fail(`page error: ${e.message}`));
  await p.goto(origin === 'shell' ? env.shell.base + '/' : env.backend.base + '/tv/');
  await p.waitForSelector('#rows tr');
  return p;
};
const FOLDER_B = 'https://drive.google.com/drive/folders/DRIVE_B_ROOT_FOLDER_12?usp=sharing';

t('TEST 1: process Drive A -> ads are cached -> they play from the cache', async (env) => {
  const p = await open(env);
  await page.waitSaved(p, 3);
  const db = await page.db(p);
  assert.equal(db.keys.length, 3);
  assert.equal(db.committed.sourceName, 'Drive A');
  assert.deepEqual(db.committed.ads, ['ad1.jpg', 'ad2.mp4', 'ad3.png']);
  await page.start(p);
  await p.waitForSelector('#stage img, #stage video');
  assert.equal((await page.playing(p)).cached, true, 'plays the saved copy');
});

test('TEST 1b: pasting a link on the front page (no folder yet) leads to the TV page and saved ads', { skip: ready ? false : 'needs Playwright and ffmpeg', timeout: 90000 }, async (ctx) => {
  const env = await createEnv({ source: '' });
  ctx.after(() => env.close());
  const front = await env.context.newPage();
  await front.goto(env.backend.base + '/');
  await front.fill('#link', `https://drive.google.com/drive/folders/${ROOT_ID}?usp=sharing`);
  await front.click('#go');
  await front.waitForURL('**/tv/');
  await front.waitForSelector('#rows tr');
  await page.waitSaved(front, 3);
  assert.equal((await page.db(front)).committed.sourceName, 'Drive A');
  assert.match(await front.innerText('#f-folder'), /Drive A/);
  assert.match(await front.innerText('#f-saved'), /3 of 3 ads/);
  assert.match(await front.innerText('#f-conn'), /Online/);
});

t('TEST 1c: the front page with the folder already connected opens the TV page at once, even if Drive is unreachable', async (env) => {
  await new Promise((r) => { env.google.server.closeAllConnections?.(); env.google.server.close(r); });
  const front = await env.context.newPage();
  await front.goto(env.backend.base + '/');
  await until(async () => (await front.innerText('#current')).includes('Drive A'), 'the connected folder is known');
  const started = Date.now();
  await front.fill('#link', `https://drive.google.com/drive/u/1/folders/${ROOT_ID}?usp=sharing`);
  await front.click('#go');
  await front.waitForURL('**/tv/', { timeout: 5000 });
  assert.ok(Date.now() - started < 5000);
  await front.waitForSelector('#rows tr');
});

t('TEST 2: refresh with internet -> the saved ads are used and nothing is downloaded again', async (env) => {
  const p = await open(env);
  await page.waitSaved(p, 3);
  const before = await page.db(p);
  const requests = [];
  page.contentRequests(p, requests);
  await p.reload();
  await p.waitForSelector('#rows tr');
  await page.waitSaved(p, 3);
  assert.deepEqual(requests, [], 'no file was downloaded again');
  assert.deepEqual(await page.db(p), before);
});

t('TEST 3: internet lost while playing -> the saved ads keep playing, Wi-Fi turns red', async (env) => {
  const p = await open(env);
  await page.waitSaved(p, 3);
  await page.start(p);
  await p.waitForSelector('#stage img, #stage video');
  await env.context.setOffline(true);
  const seen = new Set();
  const t0 = Date.now();
  while (Date.now() - t0 < 9000) { const now = await page.playing(p); if (now) seen.add(`${now.kind}:${now.cached}`); await p.waitForTimeout(200); }
  assert.equal(await p.getAttribute('#wifi', 'class'), 'wifi off');
  await env.context.setOffline(false);
  assert.ok(seen.size > 0 && [...seen].every((s) => s.endsWith(':true')), `only saved copies played: ${[...seen]}`);
  assert.ok(seen.has('video:true') && seen.has('image:true'), `images and video both kept playing: ${[...seen]}`);
});

t('TEST 4: no internet / backend before start-up -> the app opens from the saved list and plays', async (env) => {
  let p = await open(env);
  await page.waitSaved(p, 3);
  await p.close();
  await env.backend.close();                    // the backend is gone completely
  p = await env.context.newPage();
  await p.goto(env.shell.base + '/');
  await p.waitForSelector('#rows tr', { timeout: 20000 });
  assert.equal((await page.rows(p)).length, 3);
  assert.equal(await p.getAttribute('#wifi', 'class'), 'wifi off');
  assert.match(await p.innerText('#f-conn'), /Offline/);
  await page.start(p);
  await p.waitForSelector('#stage img, #stage video');
  assert.equal((await page.playing(p)).cached, true);
});

t('TEST 5: entering the same Drive link again changes nothing and downloads nothing', async (env) => {
  const p = await open(env);
  await page.waitSaved(p, 3);
  const before = await page.db(p);
  const requests = [];
  page.contentRequests(p, requests);
  const res = await fetch(`${env.backend.base}/api/source`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ link: `https://drive.google.com/drive/folders/${ROOT_ID}` }) });
  const body = await res.json();
  assert.equal(body.unchanged, true);
  await page.triggerCheck(p);
  await p.waitForTimeout(1500);
  assert.deepEqual(requests, []);
  assert.deepEqual(await page.db(p), before);
});

t('TEST 6: a different valid link asks first; Cancel keeps everything; confirming replaces the saved ads', async (env) => {
  const p = await open(env);
  await page.waitSaved(p, 3);
  const before = await page.db(p);

  const front = await env.context.newPage();
  await front.goto(env.backend.base + '/');
  await front.fill('#link', FOLDER_B);
  await front.click('#go');
  await front.waitForSelector('#overlay:not([hidden])');
  assert.match(await front.innerText('#dialog'), /Change Drive folder\?/);
  assert.match(await front.innerText('#dialog'), /remove the currently cached advertisements/);
  await front.click('#cancel');
  await front.waitForSelector('#msg:not([hidden])');
  assert.match(await front.innerText('#msg'), /Nothing was changed/);
  assert.equal(env.backend.sync.getSource().folderId, ROOT_ID, 'Cancel keeps the active folder');
  assert.deepEqual(await page.db(p), before, 'Cancel keeps the saved ads');

  await front.click('#go');
  await front.waitForSelector('#overlay:not([hidden])');
  await front.click('#confirm');
  await front.waitForURL('**/tv/');
  assert.equal(env.backend.sync.getSource().folderName, 'Drive B');

  // the already-open TV page keeps playing Drive A until Drive B is fully saved, then switches
  await page.triggerCheck(p);
  await p.waitForFunction(() => document.querySelectorAll('#rows tr').length === 2, null, { timeout: 25000 });
  const after = await page.db(p);
  assert.equal(after.committed.sourceName, 'Drive B');
  assert.deepEqual(after.committed.ads, ['b1.png', 'b2.jpg']);
  assert.equal(after.keys.length, 2, 'the old folder files are gone');
  assert.match(await p.innerText('#f-folder'), /Drive B/);
});

t('TEST 7: an invalid / inaccessible link leaves the saved ads and the active folder untouched', async (env) => {
  const p = await open(env);
  await page.waitSaved(p, 3);
  const before = await page.db(p);
  const front = await env.context.newPage();
  await front.goto(env.backend.base + '/');
  for (const link of ['https://drive.google.com/drive/folders/DOES_NOT_EXIST_123456', 'https://drive.google.com/file/d/ABCDEFGHIJKLMNOP/view', 'https://example.com/x']) {
    await front.fill('#link', link);
    await front.click('#go');
    await front.waitForSelector('#msg.bad');
    assert.equal(await front.isVisible('#overlay'), false, 'no scary dialog for a link that does not work');
  }
  // a valid folder that has no ads must not replace a working playlist either
  await front.fill('#link', 'https://drive.google.com/drive/folders/EMPTY_DRIVE_FOLDER_12');
  await front.click('#go');
  await front.waitForSelector('#overlay:not([hidden])');
  await front.click('#confirm');
  await front.waitForSelector('#msg.bad');
  assert.match(await front.innerText('#msg'), /no supported ads/);
  assert.equal(env.backend.sync.getSource().folderId, ROOT_ID);
  assert.deepEqual(await page.db(p), before);
  assert.equal(env.backend.sync.getManifest().ads.length, 3);
});

t('TEST 8: Drive answers with nothing or with errors -> the saved ads stay', async (env) => {
  const p = await open(env);
  await page.waitSaved(p, 3);
  const before = await page.db(p);
  env.google.server.emptyLists = true;
  await env.backend.sync.sync();                       // an empty answer is held back
  await page.triggerCheck(p);
  await p.waitForTimeout(1200);
  assert.equal((await page.rows(p)).length, 3);
  env.google.server.emptyLists = false;
  env.google.server.fault = { status: 503, count: 100000 };
  for (let i = 0; i < 3; i++) await env.backend.sync.sync().catch(() => {});
  await page.triggerCheck(p);
  await p.waitForFunction(() => /could not reach Google Drive/.test(document.getElementById('cache-note').textContent), null, { timeout: 8000 });
  assert.equal((await page.rows(p)).length, 3);
  assert.deepEqual(await page.db(p), before);
});

t('TEST 9: one ad changes -> only that ad is downloaded again', async (env) => {
  const p = await open(env);
  await page.waitSaved(p, 3);
  const before = await page.db(p);
  const requests = [];
  page.contentRequests(p, requests);
  const bytes = mediaFiles().png('orange');
  env.google.media.set('A_AD3_FILE_1234567', bytes);
  Object.assign(env.google.files.get('A_AD3_FILE_1234567'), { size: String(bytes.length), md5Checksum: 'new-md5', modifiedTime: '2026-09-05T10:00:00Z' });
  await env.backend.sync.sync();
  await page.triggerCheck(p);
  await until(async () => { const d = await page.db(p); return d.keys.some((k) => k.includes('new-md5')) && !d.keys.some((k) => k.includes('md5-A_AD3')); }, { what: 'the new version to be stored and swapped in' });
  assert.deepEqual(requests, ['A_AD3_FILE_1234567']);
  const after = await page.db(p);
  assert.equal(after.keys.length, 3);
  assert.ok(after.keys.some((k) => k.includes('new-md5')) && !after.keys.some((k) => k.includes('md5-A_AD3')), 'the old version was removed after the swap');
  for (const k of before.keys.filter((k) => !k.startsWith('A_AD3'))) assert.ok(after.keys.includes(k), `${k} untouched`);
});

t('TEST 10: a new ad is added -> only the new ad is downloaded', async (env) => {
  const p = await open(env);
  await page.waitSaved(p, 3);
  const requests = [];
  page.contentRequests(p, requests);
  env.drive.add('A_AD4_FILE_1234567', 'ad4.png', 'image/png', mediaFiles().png('purple'), 'A_ADS_FOLDER_123456', { t: '2026-09-06T10:00:00Z' });
  await env.backend.sync.sync();
  await page.triggerCheck(p);
  await p.waitForFunction(() => document.querySelectorAll('#rows tr').length === 4, null, { timeout: 20000 });
  assert.deepEqual(requests, ['A_AD4_FILE_1234567']);
  assert.equal((await page.db(p)).keys.length, 4);
});

t('TEST 11: an ad is removed -> it leaves the playlist and the saved files, nothing is downloaded', async (env) => {
  const p = await open(env);
  await page.waitSaved(p, 3);
  const requests = [];
  page.contentRequests(p, requests);
  env.google.files.get('A_AD2_FILE_1234567').trashed = true;
  await env.backend.sync.sync();
  await page.triggerCheck(p);
  await p.waitForFunction(() => document.querySelectorAll('#rows tr').length === 2, null, { timeout: 15000 });
  assert.deepEqual(requests, []);
  const db = await page.db(p);
  assert.equal(db.keys.length, 2);
  assert.deepEqual(db.committed.ads, ['ad1.jpg', 'ad3.png']);
});

t('TEST 12: a download that fails keeps the old playable ads; it recovers when the file is right', async (env) => {
  const p = await open(env);
  await page.waitSaved(p, 3);
  const before = await page.db(p);
  const good = mediaFiles().png('orange');
  // the new version is announced with its real size but the server cuts it short (as a dropped connection would)
  env.google.media.set('A_AD3_FILE_1234567', good.subarray(0, Math.floor(good.length / 2)));
  Object.assign(env.google.files.get('A_AD3_FILE_1234567'), { size: String(good.length), md5Checksum: 'cut-md5', modifiedTime: '2026-09-05T10:00:00Z' });
  await env.backend.sync.sync();
  await page.triggerCheck(p);
  await p.waitForFunction(() => /Updating to a new version/.test(document.getElementById('cache-note').textContent), null, { timeout: 15000 });
  assert.deepEqual((await page.db(p)).committed, before.committed, 'the old list is still the committed one');
  assert.ok((await page.db(p)).keys.includes(before.keys.find((k) => k.startsWith('A_AD3'))), 'the old file of that ad is still stored');
  assert.deepEqual((await page.rows(p)).map((r) => r.cache), ['Saved', 'Saved', 'Saved'], 'the playlist on screen is the old one, fully saved');
  await page.start(p);
  await p.waitForSelector('#stage img, #stage video');
  assert.equal((await page.playing(p)).cached, true, 'still playing from the saved ads');
  // the file is fixed on the server; the next check completes the update
  env.google.media.set('A_AD3_FILE_1234567', good);
  await page.triggerCheck(p);
  await p.waitForFunction(() => document.getElementById('cache-note').textContent === '', null, { timeout: 20000 });
  assert.ok((await page.db(p)).keys.some((k) => k.includes('cut-md5')));
});

t('TEST 13: the backend restarts -> the last good state is served again, even with Drive down', async (env) => {
  const p = await open(env);
  await page.waitSaved(p, 3);
  const revision = env.backend.sync.getManifest().revision;
  await env.google.server.closeAllConnections?.();
  await new Promise((r) => env.google.server.close(r));      // Drive is unreachable from now on
  const again = await env.restartBackend();
  const list = await (await fetch(`${again.base}/tv/ads.json`)).json();
  assert.equal(list.revision, revision);
  assert.equal(list.ads.length, 3);
  assert.equal(again.sync.getStatus().fromDisk, true);
  await page.triggerCheck(p);
  await p.waitForTimeout(1000);
  assert.equal((await page.rows(p)).length, 3);
  assert.equal(await page.saved(p), 3);
});

test('TEST 14: internet returns after offline play -> it syncs, saves the new ad, and does not cut off the ad on screen', { skip: ready ? false : 'needs Playwright and ffmpeg', timeout: 90000 }, async (ctx) => {
  const env = await createEnv({ imageSec: 8 });
  ctx.after(() => env.close());
  const p = await open(env);
  await page.waitSaved(p, 3);
  const requests = [];
  page.contentRequests(p, requests);
  await page.start(p);
  await p.waitForSelector('#stage img');
  await p.evaluate(() => { document.querySelector('#stage img').dataset.mark = '1'; });
  await env.context.setOffline(true);
  await p.evaluate(() => window.dispatchEvent(new Event('offline')));
  env.drive.add('A_AD4_FILE_1234567', 'ad4.png', 'image/png', mediaFiles().png('purple'), 'A_ADS_FOLDER_123456', { t: '2026-09-06T10:00:00Z' });
  await env.backend.sync.sync();
  await p.waitForTimeout(800);
  assert.equal(await p.getAttribute('#wifi', 'class'), 'wifi off');
  assert.equal((await page.rows(p)).length, 3, 'offline: nothing changes');
  await env.context.setOffline(false);
  await p.evaluate(() => window.dispatchEvent(new Event('online')));
  await until(async () => (await page.db(p)).committed.ads.length === 4, { what: 'the new ad to be saved and committed' });
  assert.equal(await p.locator('#stage img[data-mark="1"]').count(), 1, 'the ad on screen was not replaced by the update');
  assert.equal(await p.getAttribute('#wifi', 'class'), 'wifi on');
  await p.waitForFunction(() => document.querySelectorAll('#rows tr').length === 4, null, { timeout: 15000 });   // switches between two ads
  assert.deepEqual(requests, ['A_AD4_FILE_1234567']);
});

test('TEST 15: the hooks used by the Android TV app: native Back is offered to the player, Server address button appears', { skip: ready ? false : 'needs Playwright and ffmpeg', timeout: 90000 }, async (ctx) => {
  const env = await createEnv();
  ctx.after(() => env.close());
  const plain = await open(env);
  assert.equal(await plain.isVisible('#change-server'), false, 'a normal browser has no Server address button');
  await plain.close();

  const app = await env.context.newPage();
  await app.addInitScript(() => { window.__changed = 0; window.TVNative = { changeServer() { window.__changed++; } }; });
  await app.goto(env.shell.base + '/');
  await app.waitForSelector('#rows tr');
  await page.waitSaved(app, 3);
  assert.equal(await app.isVisible('#change-server'), true);
  await app.click('#change-server');
  assert.equal(await app.evaluate(() => window.__changed), 1);
  assert.equal(await app.evaluate(() => window.TV_NATIVE_BACK()), false, 'not playing: Back is not consumed');
  await page.start(app);
  await app.waitForSelector('#stage img, #stage video');
  assert.equal(await app.evaluate(() => window.TV_NATIVE_BACK()), true, 'playing: Back returns to the table');
  assert.equal(await app.isVisible('#player-root'), false);
  assert.equal(await app.isVisible('#board'), true);
});
