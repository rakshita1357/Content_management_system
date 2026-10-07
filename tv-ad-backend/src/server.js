import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { createPublicReader } from './drive/publicReader.js';
import { createTokenProvider } from './drive/oauth.js';
import { createDriveWriter } from './drive/writer.js';
import { createStateStore } from './lib/stateStore.js';
import { createSyncService } from './services/syncService.js';
import { createUploadService } from './services/uploadService.js';

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`Cannot start: ${err.message}`);
  process.exit(1);
}

const log = {
  info: (m) => console.log(`${new Date().toISOString()} ${m}`),
  error: (m) => console.error(`${new Date().toISOString()} ${m}`),
};

const tokens = createTokenProvider(config);
const reader = createPublicReader(config, tokens);
const writer = tokens.isConfigured() ? createDriveWriter(config, tokens) : null;
const sync = createSyncService({ config, reader, writer, store: createStateStore(config.dataDir), log });
const uploads = createUploadService({ config, writer, sync });

await sync.init();
const server = createApp({ config, sync, uploads, log });
server.requestTimeout = 0; // large video uploads can take longer than Node's default 5 minutes

server.listen(config.port, () => {
  log.info(`Admin page: http://localhost:${config.port}/admin`);
  if (!config.adminPassword) log.info('Warning: ADMIN_PASSWORD is empty, so the admin page has no login.');
  if (!writer) log.info('Drive write access is not set up: scanning and preview work, publishing and uploads are off.');
  sync.start();
});

const shutdown = () => {
  sync.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
