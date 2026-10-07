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
