// Phase 6 browser tests: screens reporting in, resuming after a restart, reloading when the page is updated.
//   npm run test:browser
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEnv, hasFfmpeg, loadPlaywright, page, until, WEB_CORE_DIR } from './harness.mjs';

const ready = Boolean(loadPlaywright()) && hasFfmpeg();
const t = (name, opts, fn) => test(name, { skip: ready ? false : 'needs Playwright and ffmpeg', timeout: 90000 }, async (ctx) => {
  const env = await createEnv(opts);
  ctx.after(() => env.close());
  await fn(env, ctx);
});
const open = async (env, where = 'shell') => {
  const p = await env.context.newPage();
  p.on('pageerror', (e) => assert.fail(`page error: ${e.message}`));
  await p.goto(where === 'shell' ? env.shell.base + '/' : env.backend.base + '/tv/');
  await p.waitForSelector('#rows tr');
  return p;
};
const screens = async (env) => (await (await fetch(`${env.backend.base}/api/screens`)).json());

t('TEST 16: a screen reports in with what it plays and how full its storage is', {}, async (env) => {
  const p = await open(env);
  await page.waitSaved(p, 3);
  const list = await until(async () => { const l = await screens(env); return l.screens.length ? l : null; }, { what: 'the first report' });
  assert.equal(list.screens[0].kind, 'browser');
  assert.equal(list.screens[0].folder, 'Drive A');
  assert.equal(list.screens[0].revision, env.backend.sync.getManifest().revision);
  assert.match(list.screens[0].id, /^tv-[a-z0-9]+$/);
  await page.start(p);
  await p.waitForSelector('#stage img, #stage video');
  // the heartbeat is throttled to one per 5 seconds; trigger a fresh one by going offline and online again
  await new Promise((r) => setTimeout(r, 5200));
  await p.evaluate(() => { window.dispatchEvent(new Event('offline')); window.dispatchEvent(new Event('online')); });
  const later = await until(async () => { const l = await screens(env); return l.screens[0].playing ? l : null; }, { what: 'a report that says what is playing', timeout: 15000 });
  assert.match(later.screens[0].playing, /ad\d\.(jpg|mp4|png)/);
  assert.equal(later.screens[0].adsSaved, 3);
  assert.ok(later.screens[0].cacheBytes > 0);
  // the same screen keeps the same id after a reload
  const id = later.screens[0].id;
  await p.reload();
  await p.waitForSelector('#rows tr');
  await new Promise((r) => setTimeout(r, 5200));
  await p.evaluate(() => { window.dispatchEvent(new Event('offline')); window.dispatchEvent(new Event('online')); });
  await new Promise((r) => setTimeout(r, 800));
  assert.equal((await screens(env)).screens.length, 1);
  assert.equal((await screens(env)).screens[0].id, id);
});

t('TEST 17: after a restart the screen goes straight back to playing, unless someone had left the player', {}, async (env) => {
  const p = await open(env);
  await page.waitSaved(p, 3);
  await page.start(p);
  await p.waitForSelector('#stage img, #stage video');
  await p.reload();                                   // power cut / restart / update: nobody is there to press anything
  await p.waitForSelector('#stage img, #stage video', { timeout: 8000 });   // far sooner than the 10 second countdown
  assert.equal(await p.isVisible('#player-root'), true);
  assert.equal((await page.playing(p)).cached, true);
  await p.click('#exit');                             // someone chose to leave
  await p.reload();
  await p.waitForSelector('#rows tr');
  await p.waitForTimeout(1500);
  assert.equal(await p.isVisible('#player-root'), false, 'it stays on the list');
  assert.match(await p.innerText('#start'), /Start playing \(\d+\)/);
});

test('TEST 18: when the backend serves a newer page, a TV that has the old one reloads between two ads and keeps playing', { skip: ready ? false : 'needs Playwright and ffmpeg', timeout: 90000 }, async (ctx) => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'tvweb-'));
  for (const f of fs.readdirSync(WEB_CORE_DIR)) fs.copyFileSync(path.join(WEB_CORE_DIR, f), path.join(copy, f));
  const env = await createEnv({ webCoreDir: copy });
  ctx.after(() => { env.close(); fs.rmSync(copy, { recursive: true, force: true }); });
  const p = await open(env, 'backend');
  await page.waitSaved(p, 3);
  await page.start(p);
  await p.waitForSelector('#stage img, #stage video');
  await p.evaluate(() => { window.__oldPage = true; });
  const before = (await (await fetch(`${env.backend.base}/api/health`)).json()).webVersion;
  fs.appendFileSync(path.join(copy, 'player.js'), '\n// an update\n');   // web-core is updated on the server
  assert.notEqual((await (await fetch(`${env.backend.base}/api/health`)).json()).webVersion, before);
  await page.triggerCheck(p);                          // the page's regular check sees the new version
  await until(async () => !(await p.evaluate(() => window.__oldPage === true).catch(() => false)), { what: 'the page to reload', timeout: 20000 });
  await p.waitForSelector('#stage img, #stage video', { timeout: 10000 });   // and it is playing again by itself
  assert.equal(await p.isVisible('#player-root'), true);
});

t('TEST 19: the Android app has its page built in, so it does not reload when the server page changes', {}, async (env) => {
  const app = await env.context.newPage();
  await app.addInitScript(() => { window.TVNative = { changeServer() {} }; });
  await app.goto(env.shell.base + '/');
  await app.waitForSelector('#rows tr');
  await page.waitSaved(app, 3);
  await app.evaluate(() => { window.__old = true; });   // set once: a reload would lose it
  // pretend the server reports a different page version from now on
  await app.route('**/api/health', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    route.fulfill({ response: res, json: { ...body, webVersion: `v${Date.now() % 100000}`.padEnd(12, '0') } });
  });
  await app.evaluate(() => window.dispatchEvent(new Event('online')));
  await app.waitForTimeout(500);
  await app.evaluate(() => window.dispatchEvent(new Event('online')));
  await app.waitForTimeout(1500);
  assert.equal(await app.evaluate(() => window.__old === true), true, 'not reloaded');
});
