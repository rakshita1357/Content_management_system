// Phase 6: security, logging, versions, screens, damaged state.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { createPublicReader } from '../src/drive/publicReader.js';
import { createTokenProvider } from '../src/drive/oauth.js';
import { createDriveWriter } from '../src/drive/writer.js';
import { createStateStore } from '../src/lib/stateStore.js';
import { createLogger } from '../src/lib/logger.js';
import { chooseHost, createLoginLimiter, isWeakPassword } from '../src/lib/security.js';
import { appVersion, createWebVersion } from '../src/lib/version.js';
import { createScreensService } from '../src/services/screensService.js';
import { createSyncService } from '../src/services/syncService.js';
import { createUploadService } from '../src/services/uploadService.js';
import { createSourceService } from '../src/services/sourceService.js';
import { startFakeGoogle } from './fakeGoogle.js';
import { ROOT_ID, sampleDrive } from './fixtures.js';

const PASSWORD = 'a-strong-password';
const AUTH = { Authorization: `Basic ${Buffer.from(`admin:${PASSWORD}`).toString('base64')}` };
const BAD = { Authorization: `Basic ${Buffer.from('admin:wrong').toString('base64')}` };

async function setup({ env = {}, tls = null, logs = [], limiter } = {}) {
  const drive = sampleDrive();
  const google = await startFakeGoogle({ apiKey: 'k', root: drive.root, children: drive.children, rootId: ROOT_ID });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvh-'));
  const config = loadConfig({
    DRIVE_FOLDER_ID: ROOT_ID, ADMIN_PASSWORD: PASSWORD, DATA_DIR: dataDir,
    GOOGLE_CLIENT_ID: 'i', GOOGLE_CLIENT_SECRET: 's', GOOGLE_REFRESH_TOKEN: 'r',
    DRIVE_API_BASE: `${google.base}/drive/v3`, DRIVE_UPLOAD_BASE: `${google.base}/upload/drive/v3`, GOOGLE_TOKEN_URL: `${google.base}/token`, ...env,
  });
  const tokens = createTokenProvider(config);
  const reader = createPublicReader(config, tokens);
  const writer = createDriveWriter(config, tokens);
  const log = { debug: (m) => logs.push(['debug', m]), info: (m) => logs.push(['info', m]), warn: (m, f) => logs.push(['warn', m, f]), error: (m) => logs.push(['error', m]) };
  const sync = createSyncService({ config, reader, writer, store: createStateStore(dataDir), log });
  await sync.init();
  await sync.sync();
  const screens = createScreensService();
  const app = createApp({ config, sync, uploads: createUploadService({ config, writer, sync }), sources: createSourceService({ reader, sync }), reader, screens, tls, limiter, log });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `${tls ? 'https' : 'http'}://127.0.0.1:${app.address().port}`;
  return { base, config, sync, screens, google, dataDir, app, close: async () => { app.closeAllConnections(); app.close(); google.server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

test('weak passwords keep the backend on this computer unless HOST says otherwise', () => {
  for (const weak of ['', 'change-me', 'password', 'short', 'ADMIN']) assert.equal(isWeakPassword(weak), true, weak);
  assert.equal(isWeakPassword('a-strong-password'), false);
  assert.equal(chooseHost({ host: '', adminPassword: '' }), '127.0.0.1');
  assert.equal(chooseHost({ host: '', adminPassword: 'change-me' }), '127.0.0.1');
  assert.equal(chooseHost({ host: '', adminPassword: 'a-strong-password' }), '0.0.0.0');
  assert.equal(chooseHost({ host: '0.0.0.0', adminPassword: '' }), '0.0.0.0');
  assert.equal(chooseHost({ host: '192.168.1.5', adminPassword: 'a-strong-password' }), '192.168.1.5');
});

test('login limiter: lock after repeated wrong passwords, unlock after the wait, success clears the count', () => {
  let t = 1_000_000;
  const limiter = createLoginLimiter({ max: 3, windowMs: 60_000, lockMs: 120_000, now: () => t });
  limiter.fail('a'); limiter.fail('a');
  assert.equal(limiter.check('a').blocked, false);
  limiter.ok('a');                                  // a right password resets the count
  limiter.fail('a'); limiter.fail('a');
  assert.equal(limiter.check('a').blocked, false);
  limiter.fail('a');
  assert.deepEqual(limiter.check('a'), { blocked: true, retryAfterSec: 120 });
  assert.equal(limiter.check('b').blocked, false, 'other addresses are not affected');
  t += 121_000;
  assert.equal(limiter.check('a').blocked, false);
  limiter.fail('a'); t += 61_000; limiter.fail('a'); limiter.fail('a');
  assert.equal(limiter.check('a').blocked, false, 'old failures expire');
});

test('too many wrong passwords get a 429 even for the right password; asking without a password does not count', async (t) => {
  const env = await setup(); t.after(env.close);
  for (let i = 0; i < 20; i++) assert.equal((await fetch(`${env.base}/api/status`)).status, 401);   // the browser's normal first request
  assert.equal((await fetch(`${env.base}/api/status`, { headers: AUTH })).status, 200);
  for (let i = 0; i < 10; i++) assert.equal((await fetch(`${env.base}/api/status`, { headers: BAD })).status, 401);
  const locked = await fetch(`${env.base}/api/status`, { headers: AUTH });
  assert.equal(locked.status, 429);
  assert.ok(Number(locked.headers.get('retry-after')) > 0);
  assert.equal((await fetch(`${env.base}/api/health`)).status, 200, 'the TV routes are not affected');
});

test('a request started by another website is refused; the same site and non-browser clients are fine', async (t) => {
  const env = await setup(); t.after(env.close);
  const post = (origin) => fetch(`${env.base}/api/sync`, { method: 'POST', headers: { ...AUTH, ...(origin ? { Origin: origin } : {}) } });
  assert.equal((await post('https://evil.example')).status, 403);
  assert.equal((await post('null')).status, 403);
  assert.equal((await post(env.base)).status, 200);
  assert.equal((await post(null)).status, 200);
  const up = await fetch(`${env.base}/api/upload?adName=x&fileName=a.png`, { method: 'PUT', headers: { ...AUTH, Origin: 'https://evil.example', 'Content-Type': 'image/png' }, body: Buffer.alloc(10) });
  assert.equal(up.status, 403);
  assert.equal((await fetch(`${env.base}/tv/sync`, { method: 'POST', headers: { Origin: 'https://some-tv-app.example' } })).status, 200, 'the TV routes are meant to be called from the app');
});

test('every response carries the basic security headers', async (t) => {
  const env = await setup(); t.after(env.close);
  for (const p of ['/tv/', '/api/health', '/tv/ads.json']) {
    const res = await fetch(`${env.base}${p}`);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', p);
    assert.equal(res.headers.get('x-frame-options'), 'DENY', p);
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer', p);
    assert.equal(res.headers.get('strict-transport-security'), null, 'no HSTS over plain http');
  }
});

test('https works with a certificate and then sends HSTS', { skip: (() => { try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return false; } catch { return 'needs openssl'; } })() }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvtls-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${dir}/k.pem`, '-out', `${dir}/c.pem`, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  const cert = fs.readFileSync(`${dir}/c.pem`);
  const env = await setup({ tls: { cert, key: fs.readFileSync(`${dir}/k.pem`) } });
  t.after(env.close);
  const res = await new Promise((resolve, reject) => https.get(`${env.base}/api/health`, { ca: cert, servername: 'localhost' }, (r) => { let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: JSON.parse(b) })); }).on('error', reject));
  assert.equal(res.status, 200);
  assert.match(res.headers['strict-transport-security'], /max-age/);
  assert.equal(res.body.version, appVersion);
});

test('logger: levels, text and JSON lines', () => {
  const lines = [];
  const out = { log: (l) => lines.push(['out', l]), error: (l) => lines.push(['err', l]) };
  const now = () => new Date('2026-10-07T10:00:00Z');
  const text = createLogger({ level: 'info', out, now });
  text.debug('hidden'); text.info('hello'); text.warn('careful', { ip: '1.2.3.4' }); text.error('bad');
  assert.deepEqual(lines.map((l) => l[0]), ['out', 'err', 'err']);
  assert.equal(lines[0][1], '2026-10-07T10:00:00.000Z INFO  hello');
  assert.match(lines[1][1], /WARN {2}careful \{"ip":"1.2.3.4"\}/);
  lines.length = 0;
  const json = createLogger({ level: 'debug', format: 'json', out, now });
  json.debug('d', { a: 1 });
  assert.deepEqual(JSON.parse(lines[0][1]), { time: '2026-10-07T10:00:00.000Z', level: 'debug', msg: 'd', a: 1 });
});

test('the request log never contains the query string or the login, and refused requests are warnings', async (t) => {
  const logs = [];
  const env = await setup({ logs }); t.after(env.close);
  await fetch(`${env.base}/api/health?token=SECRET-VALUE`);
  await fetch(`${env.base}/api/status`, { headers: BAD });
  await new Promise((r) => setTimeout(r, 30));
  const all = JSON.stringify(logs);
  assert.doesNotMatch(all, /SECRET-VALUE/);
  assert.doesNotMatch(all, /wrong|Basic /);
  assert.ok(logs.some(([lvl, msg]) => lvl === 'warn' && /GET \/api\/status 401/.test(msg)));
  assert.ok(logs.some(([lvl, msg]) => lvl === 'debug' && /GET \/api\/health 200/.test(msg)));
});

test('version: the app version is reported, and the TV page fingerprint changes when a file changes', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvweb-'));
  for (const f of ['index.html', 'app.css', 'player.js', 'cache.js', 'config.js']) fs.writeFileSync(path.join(dir, f), `// ${f}\n`);
  const env = await setup({ env: { WEB_CORE_DIR: dir } }); t.after(env.close);
  const first = await (await fetch(`${env.base}/api/health`)).json();
  assert.equal(first.version, appVersion);
  assert.match(first.webVersion, /^[0-9a-f]{12}$/);
  assert.equal((await (await fetch(`${env.base}/api/health`)).json()).webVersion, first.webVersion, 'stable while nothing changes');
  fs.writeFileSync(path.join(dir, 'player.js'), '// player.js changed\n');
  assert.notEqual((await (await fetch(`${env.base}/api/health`)).json()).webVersion, first.webVersion);
  assert.equal(createWebVersion('/no/such/folder')(), 'missing');
});

const beat = (over = {}) => ({ id: 'screen-0001-abcd', name: 'Lobby', kind: 'browser', version: 'abc', online: true, playing: 'ad1.jpg', revision: 'abcdef012345', folder: 'Drive A', adsSaved: 3, adsTotal: 3, cacheBytes: 1000, quotaBytes: 5000, ...over });

test('screens report in through a public route and are listed for the admin', async (t) => {
  const env = await setup(); t.after(env.close);
  const post = (body) => fetch(`${env.base}/tv/heartbeat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post(beat())).status, 200);
  assert.equal((await fetch(`${env.base}/api/screens`)).status, 401, 'the list is admin only');
  const list = await (await fetch(`${env.base}/api/screens`, { headers: AUTH })).json();
  assert.equal(list.screens.length, 1);
  assert.deepEqual(Object.keys(list.screens[0]).sort(), ['adsSaved', 'adsTotal', 'ageSec', 'cacheBytes', 'firstSeen', 'folder', 'id', 'kind', 'lastSeen', 'lastSeenAt', 'name', 'online', 'playing', 'quotaBytes', 'revision', 'version']);
  assert.equal(list.screens[0].playing, 'ad1.jpg');
  assert.equal(list.currentRevision, env.sync.getManifest().revision);
  assert.ok(list.staleAfterSec >= 600);
  // a second report right away is accepted but not stored again
  assert.equal((await (await post(beat({ playing: 'other.jpg' }))).json()).throttled, true);
});

test('heartbeat input is validated: bad id, oversized body, junk fields and values', async (t) => {
  const env = await setup(); t.after(env.close);
  const post = (body, raw) => fetch(`${env.base}/tv/heartbeat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw ?? JSON.stringify(body) });
  assert.equal((await post(beat({ id: 'x' }))).status, 400);
  assert.equal((await post(beat({ id: '../../etc/passwd-aaaa' }))).status, 400);
  assert.equal((await post(null, 'not json')).status, 400);
  assert.equal((await post(null, JSON.stringify({ id: 'screen-0001-abcd', pad: 'x'.repeat(10000) }))).status, 413);
  assert.equal((await post(beat({ id: 'screen-0002-abcd', name: 'N'.repeat(500), playing: 'P'.repeat(500), revision: 'not-hex', adsSaved: -5, cacheBytes: 'lots', secret: 'do-not-keep', kind: 'toaster' }))).status, 200);
  const s = env.screens.list().find((x) => x.id === 'screen-0002-abcd');
  assert.equal(s.name.length, 60);
  assert.equal(s.playing.length, 120);
  assert.equal(s.revision, null);
  assert.equal(s.adsSaved, 0);
  assert.equal(s.cacheBytes, 0);
  assert.equal(s.kind, 'browser');
  assert.equal('secret' in s, false);
});

test('screens service: the oldest screen is dropped past the limit, and reports can be saved and loaded', async () => {
  let t = 1_000_000;
  const saved = [];
  const svc = createScreensService({ now: () => t, max: 3, persist: (rows) => saved.push(rows) });
  for (let i = 1; i <= 4; i++) { svc.report(beat({ id: `screen-000${i}-abcd` })); t += 10_000; }
  assert.deepEqual(svc.list().map((s) => s.id), ['screen-0004-abcd', 'screen-0003-abcd', 'screen-0002-abcd']);
  assert.ok(saved.length >= 1);
  const again = createScreensService({ now: () => t });
  again.load(saved.at(-1));
  assert.ok(again.list().length > 0);
  again.load([{ id: 'bad id' }, null]);                     // junk in the file is ignored
  assert.ok(again.list().every((s) => /^[A-Za-z0-9_-]+$/.test(s.id)));
});

test('a damaged state file is kept aside and the backend starts clean, saying so', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvdmg-'));
  fs.writeFileSync(path.join(dir, 'state.json'), '{ this is not json');
  const warnings = [];
  const store = createStateStore(dir, { warn: (m) => warnings.push(m) });
  assert.deepEqual(await store.load(), {});
  assert.equal(fs.existsSync(path.join(dir, 'state.json')), false);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('state.json.damaged-')), 'the damaged file is kept for inspection');
  assert.match(warnings[0], /could not be read/);
  await store.save({ ok: true });
  assert.deepEqual(await store.load(), { ok: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('config: https needs both files, log settings are checked, HOST is passed through', () => {
  const base = { DRIVE_API_KEY: 'k' };
  assert.throws(() => loadConfig({ ...base, TLS_CERT_FILE: 'c.pem' }), /both TLS_CERT_FILE and TLS_KEY_FILE/);
  assert.deepEqual(loadConfig({ ...base, TLS_CERT_FILE: 'c.pem', TLS_KEY_FILE: 'k.pem' }).tls, { certFile: 'c.pem', keyFile: 'k.pem' });
  assert.equal(loadConfig(base).tls, null);
  assert.throws(() => loadConfig({ ...base, LOG_LEVEL: 'loud' }), /LOG_LEVEL must be one of/);
  assert.throws(() => loadConfig({ ...base, LOG_FORMAT: 'xml' }), /LOG_FORMAT must be one of/);
  assert.equal(loadConfig({ ...base, HOST: '0.0.0.0' }).host, '0.0.0.0');
  assert.equal(loadConfig(base).logLevel, 'info');
});
