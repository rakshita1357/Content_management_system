import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { createPublicReader } from './drive/publicReader.js';
import { createTokenProvider } from './drive/oauth.js';
import { createDriveWriter } from './drive/writer.js';
import { createLogger } from './lib/logger.js';
import { chooseHost, isWeakPassword } from './lib/security.js';
import { createStateStore } from './lib/stateStore.js';
import { appVersion } from './lib/version.js';
import { createScreensService } from './services/screensService.js';
import { createSyncService } from './services/syncService.js';
import { createUploadService } from './services/uploadService.js';
import { createSourceService } from './services/sourceService.js';

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`Cannot start: ${err.message}`);
  process.exit(1);
}

const log = createLogger({ level: config.logLevel, format: config.logFormat });

// If something unexpected breaks, say so and stop: the service manager (systemd, Docker, Windows service) restarts the
// backend, which is safer than carrying on in an unknown state. Everything important is saved in data/ atomically.
process.on('uncaughtException', (err) => {
  log.error(`Unexpected error, stopping so the service can restart: ${err.stack || err}`);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  log.error(`Unexpected rejection, stopping so the service can restart: ${err?.stack || err}`);
  process.exit(1);
});

const store = createStateStore(config.dataDir, log);
const tokens = createTokenProvider(config);
const reader = createPublicReader(config, tokens);
const writer = tokens.isConfigured() ? createDriveWriter(config, tokens) : null;
const sync = createSyncService({ config, reader, writer, store, log });
const uploads = createUploadService({ config, writer, sync });
const sources = createSourceService({ reader, sync });

// Which screens have reported in is remembered across restarts (a small file, written at most every 30 s).
const screensFile = path.join(config.dataDir, 'screens.json');
const screens = createScreensService({
  persist: (rows) => fs.promises.mkdir(config.dataDir, { recursive: true }).then(() => fs.promises.writeFile(`${screensFile}.tmp`, JSON.stringify(rows)).then(() => fs.promises.rename(`${screensFile}.tmp`, screensFile))),
});
try { screens.load(JSON.parse(fs.readFileSync(screensFile, 'utf8'))); } catch { /* none yet */ }

await sync.init();

let tls = null;
if (config.tls) {
  try {
    tls = { cert: fs.readFileSync(config.tls.certFile), key: fs.readFileSync(config.tls.keyFile) };
  } catch (err) {
    log.error(`Cannot start: could not read the TLS files (${err.message}).`);
    process.exit(1);
  }
}

const server = createApp({ config, sync, uploads, sources, reader, screens, tls, log });
server.requestTimeout = 0; // large video uploads can take longer than Node's default 5 minutes

const host = chooseHost(config);
const scheme = tls ? 'https' : 'http';
server.listen(config.port, host, () => {
  log.info(`TV ads backend ${appVersion} listening on ${scheme}://${host}:${config.port}`);
  log.info(`Start page (paste a Drive folder link): ${scheme}://localhost:${config.port}/`);
  log.info(`TV page: ${scheme}://localhost:${config.port}/tv/    Admin page: ${scheme}://localhost:${config.port}/admin`);
  if (host === '127.0.0.1' || host === 'localhost') {
    if (!config.host && isWeakPassword(config.adminPassword)) {
      log.warn('ADMIN_PASSWORD is empty, short or a placeholder, so the backend only accepts connections from this computer. Set a password of at least 8 characters to let TVs on the network reach it (or set HOST=0.0.0.0 to allow it anyway).');
    }
  } else {
    const lan = Object.values(os.networkInterfaces()).flat().filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n.address);
    for (const ip of lan) log.info(`Open this on the TV (same Wi-Fi/network): ${scheme}://${ip}:${config.port}/tv/`);
    if (!lan.length) log.info('No network address found. The TV can only reach this backend over a network.');
    if (isWeakPassword(config.adminPassword)) log.warn('The admin password is empty, short or a placeholder and the backend is open to the network. Set a real ADMIN_PASSWORD.');
  }
  if (!tls && host !== '127.0.0.1') log.info('Traffic is not encrypted (http). For anything beyond a trusted local network use https: see deploy/README.md.');
  if (!writer) log.info('Drive write access is not set up: scanning and playing work, uploads are off.');
  sync.start();
});

const shutdown = () => {
  log.info('Stopping.');
  sync.stop();
  server.close(() => process.exit(0));
  server.closeAllConnections?.();
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
