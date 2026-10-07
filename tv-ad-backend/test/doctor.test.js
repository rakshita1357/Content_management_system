import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createPublicReader } from '../src/drive/publicReader.js';
import { createTokenProvider } from '../src/drive/oauth.js';
import { createStateStore } from '../src/lib/stateStore.js';
import { runDoctor } from '../src/lib/doctor.js';
import { startFakeGoogle } from './fakeGoogle.js';
import { ROOT_ID, sampleDrive } from './fixtures.js';

async function check(env = {}, { badToken = false } = {}) {
  const drive = sampleDrive();
  const google = await startFakeGoogle({ apiKey: 'k', root: drive.root, children: drive.children, rootId: ROOT_ID });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvdoc-'));
  const config = loadConfig({
    DRIVE_FOLDER_ID: ROOT_ID, ADMIN_PASSWORD: 'a-strong-password', DATA_DIR: dataDir, PORT: String(41000 + Math.floor(Math.random() * 20000)),
    GOOGLE_CLIENT_ID: 'i', GOOGLE_CLIENT_SECRET: 's', GOOGLE_REFRESH_TOKEN: 'r',
    GOOGLE_RETRIES: '0', GOOGLE_RETRY_BASE_MS: '1', GOOGLE_TIMEOUT_MS: '500',
    DRIVE_API_BASE: `${google.base}/drive/v3`, DRIVE_UPLOAD_BASE: `${google.base}/upload/drive/v3`,
    GOOGLE_TOKEN_URL: badToken ? 'http://127.0.0.1:9/token' : `${google.base}/token`, ...env,
  });
  try {
    const tokens = createTokenProvider(config);
    const results = await runDoctor({ config, tokens, reader: createPublicReader(config, tokens), store: createStateStore(dataDir) });
    return Object.fromEntries(results.map((r) => [r.name, r]));
  } finally {
    google.server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

test('doctor: a healthy installation passes every check', async () => {
  const r = await check();
  for (const name of ['Node.js', 'TV page files', 'Data folder', 'Admin password', 'Google sign-in']) assert.equal(r[name].level, 'ok', `${name}: ${r[name].detail}`);
  assert.equal(r['Drive folder'].level, 'ok');
  assert.match(r['Drive folder'].detail, /"Test root" opened, 2 ad folders/);
  assert.equal(r.Network.level, 'ok');
});

test('doctor: each problem says what is wrong and what to do', async () => {
  const bad = await check({ ADMIN_PASSWORD: 'change-me', WEB_CORE_DIR: '/no/such/web-core' }, { badToken: true });
  assert.equal(bad['Admin password'].level, 'warn');
  assert.equal(bad.Network.level, 'warn');
  assert.match(bad.Network.detail, /this computer only/);
  assert.equal(bad['TV page files'].level, 'fail');
  assert.match(bad['TV page files'].fix, /web-core/);
  assert.equal(bad['Google sign-in'].level, 'fail');
  assert.ok(bad['Google sign-in'].fix);
  assert.equal(bad['Drive folder'].level, 'warn', 'not checked when sign-in fails');
  const old = await runDoctor({ config: loadConfig({ DRIVE_API_KEY: 'k' }), tokens: createTokenProvider(loadConfig({ DRIVE_API_KEY: 'k' })), reader: {}, store: { load: async () => ({}) }, nodeVersion: '18.0.0' });
  assert.equal(old.find((x) => x.name === 'Node.js').level, 'fail');
});

test('doctor: a data folder that cannot be written is reported', async () => {
  const file = path.join(os.tmpdir(), `tvdoc-file-${Date.now()}`);
  fs.writeFileSync(file, 'x');
  const r = await check({ DATA_DIR: path.join(file, 'inside') });   // a folder cannot be created inside a file
  fs.rmSync(file);
  assert.equal(r['Data folder'].level, 'fail');
  assert.match(r['Data folder'].fix, /write access/);
});

// ---- the port check and the start-up message ----
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { whoUsesPort, portInUseMessage } from '../src/lib/portProbe.js';

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const ourBackend = () => http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, webVersion: 'abc', version: '9.9.9' })); });

test('port probe tells another copy of this backend from another program', async () => {
  const ours = ourBackend();
  const other = http.createServer((req, res) => res.end('hello'));
  const raw = net.createServer((s) => s.destroy());
  const ports = [await listen(ours), await listen(other), await listen(raw)];
  try {
    assert.deepEqual(await whoUsesPort(ports[0]), { ours: true, version: '9.9.9' });
    assert.equal((await whoUsesPort(ports[1])).ours, false);
    assert.equal((await whoUsesPort(ports[2], { timeoutMs: 500 })).ours, false);
  } finally { ours.close(); other.close(); raw.close(); }
  assert.equal((await whoUsesPort(1, { timeoutMs: 300 })).ours, false, 'nothing there');
  assert.match(portInUseMessage(8080, { ours: true, version: '1.2.3' }), /another copy of this backend \(version 1\.2\.3\).*PORT=8081/);
  assert.match(portInUseMessage(8080, { ours: false }), /another program.*PORT=8081/);
});

test('doctor: a port held by a running backend is fine to check, a port held by something else is a warning with a fix', async () => {
  const ours = ourBackend();
  const other = http.createServer((req, res) => res.end('hello'));
  const p1 = await listen(ours);
  const p2 = await listen(other);
  try {
    const a = await check({ PORT: String(p1), HOST: '127.0.0.1' });
    assert.equal(a.Port.level, 'ok');
    assert.match(a.Port.detail, /running copy of this backend \(version 9\.9\.9\)/);
    const b = await check({ PORT: String(p2), HOST: '127.0.0.1' });
    assert.equal(b.Port.level, 'warn');
    assert.match(b.Port.detail, /another program/);
    assert.match(b.Port.fix, /PORT=/);
  } finally { ours.close(); other.close(); }
});

test('starting a second backend on the same port explains why it stopped (no crash text)', { timeout: 40000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvport-'));
  const port = 46000 + Math.floor(Math.random() * 3000);
  const server = fileURLToPath(new URL('../src/server.js', import.meta.url));
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, DRIVE_API_KEY: 'k', LOG_LEVEL: 'info' };
  const run = () => spawn(process.execPath, [server], { env });
  const first = run();
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('first backend did not start')), 15000);
      first.stdout.on('data', (d) => { if (String(d).includes('listening on')) { clearTimeout(t); resolve(); } });
      first.on('exit', () => reject(new Error('first backend exited')));
    });
    const second = run();
    let out = '';
    second.stdout.on('data', (d) => { out += d; });
    second.stderr.on('data', (d) => { out += d; });
    const code = await new Promise((resolve) => second.on('exit', resolve));
    assert.equal(code, 1);
    assert.match(out, /already in use by another copy of this backend/);
    assert.match(out, new RegExp(`PORT=${port + 1}`));
    assert.doesNotMatch(out, /Unexpected error|so the service can restart|at Server\.setupListenHandle/, 'no crash text or stack trace');
  } finally {
    first.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
