// Service account login and the database store. The database tests need a real Postgres:
//   TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/db npm test        (they are skipped otherwise)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { createTokenProvider } from '../src/drive/oauth.js';
import { createPgStore } from '../src/lib/pgStore.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const KEY_FILE = { type: 'service_account', client_email: 'tv-ads@project.iam.gserviceaccount.com', private_key: privateKey };
const ENV = { ADMIN_PASSWORD: 'long-enough-password' };
const quiet = { warn() {}, info() {}, error() {} };

test('a service account key (JSON or base64) is accepted instead of OAuth, and a broken one is explained', () => {
  const asJson = loadConfig({ ...ENV, GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(KEY_FILE) });
  assert.equal(asJson.serviceAccount.email, KEY_FILE.client_email);
  const asB64 = loadConfig({ ...ENV, GOOGLE_SERVICE_ACCOUNT_JSON: Buffer.from(JSON.stringify(KEY_FILE)).toString('base64') });
  assert.equal(asB64.serviceAccount.email, KEY_FILE.client_email);
  // private keys pasted on one line with \n escapes work too
  const escaped = loadConfig({ ...ENV, GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ ...KEY_FILE, private_key: privateKey.replace(/\n/g, '\\n') }).replace(/\\\\n/g, '\\n') });
  assert.ok(escaped.serviceAccount.privateKey.includes('\n'));
  assert.throws(() => loadConfig({ ...ENV, GOOGLE_SERVICE_ACCOUNT_JSON: 'not json' }), /GOOGLE_SERVICE_ACCOUNT_JSON/);
  assert.throws(() => loadConfig({ ...ENV, GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: 'a@b.c' }) }), /private_key/);
  assert.throws(() => loadConfig({ ...ENV }), /service account/);
  assert.throws(() => loadConfig({ ...ENV, GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(KEY_FILE), DATABASE_URL: 'mysql://x' }), /DATABASE_URL/);
});

test('the service account signs a valid token request and the access token is reused until it nearly expires', async () => {
  const config = loadConfig({ ...ENV, GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(KEY_FILE) });
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, form: new URLSearchParams(init.body) });
    return new Response(JSON.stringify({ access_token: 'tok-1', expires_in: 3600 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const tokens = createTokenProvider(config, fetchImpl);
  assert.equal(tokens.isConfigured(), true);
  assert.equal(tokens.serviceAccountEmail, KEY_FILE.client_email);
  assert.equal(await tokens.getAccessToken(), 'tok-1');
  assert.equal(await tokens.getAccessToken(), 'tok-1');
  assert.equal(requests.length, 1, 'cached');

  const { form } = requests[0];
  assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const [header, claims, signature] = form.get('assertion').split('.');
  const verify = createVerify('RSA-SHA256').update(`${header}.${claims}`);
  assert.equal(verify.verify(publicKey, Buffer.from(signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64')), true, 'signed with the account key');
  const body = JSON.parse(Buffer.from(claims, 'base64url').toString());
  assert.equal(body.iss, KEY_FILE.client_email);
  assert.equal(body.scope, 'https://www.googleapis.com/auth/drive');
  assert.equal(body.aud, config.urls.token);
  assert.ok(body.exp - body.iat <= 3600);
});

test('a rejected service account explains what to check', async () => {
  const config = loadConfig({ ...ENV, GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(KEY_FILE) });
  const tokens = createTokenProvider(config, async () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }), { status: 400 }));
  await assert.rejects(() => tokens.getAccessToken(), (err) => /invalid_grant/.test(err.message) && /GOOGLE_SERVICE_ACCOUNT_JSON/.test(err.hint));
});

test('without the pg package the database setting explains what to install', async () => {
  await assert.rejects(() => createPgStore('postgresql://u:p@localhost/db', quiet, { pg: { get Pool() { throw new Error('missing'); } } }), /pg/);
});

const dbUrl = process.env.TEST_DATABASE_URL;
test('database store: saves and reloads state, the ad list and screens, and removing the list works', { skip: dbUrl ? false : 'set TEST_DATABASE_URL to a Postgres database' }, async () => {
  const store = await createPgStore(dbUrl, quiet);
  try {
    await store.init();
    await store.init(); // creating the table twice is fine
    await store.save({ source: { folderId: 'A', folderName: 'CMS' }, publishedRevision: 'abc' });
    await store.saveManifest({ revision: 'r1', ads: [{ id: '1' }] });
    await store.saveScreens([{ id: 'screen-0001', folder: 'CMS' }]);
    const again = await createPgStore(dbUrl, quiet); // a "restart"
    try {
      assert.deepEqual((await again.load()).source, { folderId: 'A', folderName: 'CMS' });
      assert.equal((await again.loadManifest()).revision, 'r1');
      assert.deepEqual(await again.loadScreens(), [{ id: 'screen-0001', folder: 'CMS' }]);
      await again.save({ source: { folderId: 'B' } });
      await again.saveManifest(null);
      assert.equal(await again.loadManifest(), null);
      assert.equal((await store.load()).source.folderId, 'B', 'overwritten, not duplicated');
    } finally { await again.close(); }
  } finally {
    await store.save({}); await store.saveManifest(null); await store.saveScreens([]);
    await store.close();
  }
});

test('database store: an unreachable database gives a clear error after retrying', async () => {
  const store = await createPgStore('postgresql://u:p@127.0.0.1:1/db', quiet);
  await assert.rejects(() => store.init({ attempts: 2, waitMs: 10 }), (err) => /Cannot reach the database/.test(err.message) && /DATABASE_URL/.test(err.hint));
  await store.close();
});

// The real server process, with a service account and a database, restarted with an empty data folder: nothing is lost.
test('server: with DATABASE_URL the folder, ads and screens survive a restart that wipes the disk', { skip: dbUrl ? false : 'set TEST_DATABASE_URL to a Postgres database', timeout: 60000 }, async (t) => {
  const { spawn } = await import('node:child_process');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const net = await import('node:net');
  const path = await import('node:path');
  const { startFakeGoogle } = await import('./fakeGoogle.js');
  const { sampleDrive, ROOT_ID } = await import('./fixtures.js');
  const google = await startFakeGoogle({ apiKey: 'k', ...sampleDrive(), rootId: ROOT_ID, rootName: 'Main' });
  t.after(() => { google.server.closeAllConnections?.(); google.server.close(); });
  const port = await new Promise((resolve) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const base = `http://127.0.0.1:${port}`;
  const auth = { Authorization: `Basic ${Buffer.from('admin:long-enough-password').toString('base64')}` };

  const run = async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'tvads-wiped-'));   // a brand-new empty disk each time
    const child = spawn(process.execPath, ['src/server.js'], {
      cwd: new URL('..', import.meta.url).pathname,
      env: {
        PATH: process.env.PATH, PORT: String(port), HOST: '127.0.0.1', ADMIN_PASSWORD: 'long-enough-password', DATA_DIR: dataDir, DATABASE_URL: dbUrl,
        GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(KEY_FILE), GOOGLE_RETRIES: '0',
        DRIVE_API_BASE: `${google.base}/drive/v3`, DRIVE_UPLOAD_BASE: `${google.base}/upload/drive/v3`, GOOGLE_TOKEN_URL: `${google.base}/token`,
      },
      stdio: 'ignore',
    });
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 100)); }
    return { child, dataDir, stop: async () => { child.kill(); await new Promise((r) => child.once('exit', r)); await rm(dataDir, { recursive: true, force: true }); } };
  };

  const first = await run();
  const setup = await (await fetch(`${base}/api/health`)).json();
  assert.equal(setup.needsSetup, true);
  const submit = await fetch(`${base}/api/source`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ link: `https://drive.google.com/drive/folders/${ROOT_ID}` }) });
  assert.equal(submit.status, 200);
  const connected = await (await fetch(`${base}/api/health`)).json();
  assert.ok(connected.ads > 0 && !connected.needsSetup);
  await fetch(`${base}/tv/heartbeat`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ id: 'screen-living-room', name: 'Lobby TV', folder: 'Main', online: true }) });
  await new Promise((r) => setTimeout(r, 300));
  await first.stop();

  // "Restart on a new empty disk": the folder and the ad list come back from the database.
  const second = await run();
  t.after(second.stop);
  const back = await (await fetch(`${base}/api/health`)).json();
  assert.equal(back.needsSetup, false);
  assert.equal(back.ads, connected.ads);
  assert.equal((await (await fetch(`${base}/tv/ads.json`)).json()).ads.length, connected.ads);
  assert.equal((await (await fetch(`${base}/api/source`, { headers: auth })).json()).source.folderName, 'Main');
  const seen = (await (await fetch(`${base}/api/screens`, { headers: auth })).json()).screens;
  assert.deepEqual(seen.map((s) => [s.name, s.folder]), [['Lobby TV', 'Main']], 'the screen and its folder are remembered too');
});
