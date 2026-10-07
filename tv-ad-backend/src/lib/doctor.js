import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { chooseHost, isWeakPassword } from './security.js';

const WEB_FILES = ['index.html', 'app.css', 'player.js', 'cache.js', 'config.js'];

/**
 * Checks that this installation can run: the things that most often go wrong when the backend is put on a real
 * machine. Each check says what is wrong AND what to do. Returns [{ name, level: 'ok' | 'warn' | 'fail', detail, fix }].
 */
export async function runDoctor({ config, tokens, reader, store, nodeVersion = process.versions.node }) {
  const results = [];
  const add = (name, level, detail, fix = null) => results.push({ name, level, detail, fix });

  const major = Number(String(nodeVersion).split('.')[0]);
  if (major >= 22) add('Node.js', 'ok', `version ${nodeVersion}`);
  else add('Node.js', 'fail', `version ${nodeVersion} is too old`, 'Install Node.js 22 or newer.');

  const missing = WEB_FILES.filter((f) => !fs.existsSync(path.join(config.webCoreDir, f)));
  if (!missing.length) add('TV page files', 'ok', `found in ${config.webCoreDir}`);
  else add('TV page files', 'fail', `missing ${missing.join(', ')} in ${config.webCoreDir}`, 'Keep the web-core folder next to tv-ad-backend, or set WEB_CORE_DIR to its location.');

  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const probe = path.join(config.dataDir, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe);
    add('Data folder', 'ok', `${config.dataDir} is writable`);
  } catch (err) {
    add('Data folder', 'fail', `${config.dataDir} is not writable (${err.code || err.message})`, 'Create it and give the account that runs the backend write access, or set DATA_DIR.');
  }

  if (isWeakPassword(config.adminPassword)) {
    add('Admin password', 'warn', 'empty, shorter than 8 characters, or a placeholder', 'Set ADMIN_PASSWORD to something long and private. Until then the backend only accepts connections from this computer.');
  } else add('Admin password', 'ok', 'set');

  let googleOk = false;
  if (tokens.isConfigured()) {
    try {
      await tokens.getAccessToken();
      googleOk = true;
      add('Google sign-in', 'ok', 'the saved login works');
    } catch (err) {
      add('Google sign-in', 'fail', err.message, err.hint || 'Run "npm run auth" again.');
    }
  } else if (config.apiKey) {
    googleOk = true;
    add('Google sign-in', 'warn', 'no OAuth login, only an API key', 'This only sees folders shared as "Anyone with the link". Run "npm run auth" for private folders and uploads.');
  } else {
    add('Google sign-in', 'fail', 'neither OAuth nor an API key is set', 'See the README, steps 2 to 4.');
  }

  const saved = (await store.load()).source;
  const folderId = saved?.folderId || config.rootFolderId;
  if (!folderId) {
    add('Drive folder', 'warn', 'no folder chosen yet', 'Open the backend front page and paste a Drive folder link.');
  } else if (!googleOk) {
    add('Drive folder', 'warn', 'not checked because Google sign-in failed');
  } else {
    try {
      const folder = await reader.getFolder(folderId);
      const children = await reader.listChildren(folderId);
      const adFolders = children.filter((c) => c.mimeType === 'application/vnd.google-apps.folder').length;
      add('Drive folder', adFolders ? 'ok' : 'warn', `"${folder.name}" opened, ${adFolders} ad folder${adFolders === 1 ? '' : 's'}`, adFolders ? null : 'Put each ad in its own subfolder of that folder.');
    } catch (err) {
      add('Drive folder', 'fail', err.message, err.hint || 'Check the link and that the signed-in Google account can open the folder.');
    }
  }

  const host = chooseHost(config);
  add('Network', host === '127.0.0.1' ? 'warn' : 'ok',
    `listens on ${config.tls ? 'https' : 'http'}://${host}:${config.port}${host === '127.0.0.1' ? ' (this computer only: TVs cannot reach it)' : ''}`,
    host === '127.0.0.1' ? 'Set a real ADMIN_PASSWORD (or HOST=0.0.0.0) to let TVs on the network connect.' : (config.tls ? null : 'Plain http is fine on a trusted local network. Use https (TLS_CERT_FILE/TLS_KEY_FILE or a reverse proxy) beyond that.'));

  const free = await new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', (err) => resolve(err.code || 'error'));
    probe.listen(config.port, host, () => probe.close(() => resolve(null)));
  });
  if (!free) add('Port', 'ok', `${config.port} is free`);
  else add('Port', 'warn', `${config.port} cannot be used right now (${free})`, 'If the backend is already running this is expected. Otherwise stop what uses the port or change PORT.');

  return results;
}
