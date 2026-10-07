import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { AppError } from './lib/errors.js';
import { isAuthorized, sendJson, sendText } from './lib/http.js';

const ADMIN_PAGE = new URL('../public/admin.html', import.meta.url);

/**
 * Routes
 *   GET  /healthz              liveness check (no login)
 *   GET  /admin                admin page
 *   GET  /api/status           sync and publishing status
 *   GET  /api/ads              current ads.json
 *   POST /api/sync             rescan Drive and publish now
 *   PUT  /api/upload?adName=&fileName=   raw file body, streamed to Drive
 *   GET  /preview/index.html   the TV page as it will be published
 *   GET  /preview/ads.json     the manifest as it will be published
 */
export function createApp({ config, sync, uploads, log = console }) {
  const routes = {
    'GET /': (req, res) => { res.writeHead(302, { Location: '/admin' }); res.end(); },
    'GET /admin': async (req, res) => sendText(res, 200, 'text/html', await readFile(ADMIN_PAGE, 'utf8')),
    'GET /api/status': (req, res) => sendJson(res, 200, sync.getStatus()),
    'GET /api/ads': (req, res) => sendJson(res, 200, sync.getManifest() || { ads: [], skipped: [] }),
    'POST /api/sync': async (req, res) => sendJson(res, 200, await sync.sync({ reason: 'manual', force: true })),
    'PUT /api/upload': async (req, res, url) => {
      const result = await uploads.upload({
        adName: url.searchParams.get('adName'),
        fileName: url.searchParams.get('fileName'),
        mimeType: String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase(),
        size: Number(req.headers['content-length']),
        stream: Readable.toWeb(req),
      });
      sendJson(res, 201, result);
    },
    'GET /preview/index.html': (req, res) => {
      const html = sync.getIndexHtml();
      if (!html) throw new AppError(503, 'No scan has finished yet. Wait a moment or press "Sync now".');
      sendText(res, 200, 'text/html', html);
    },
    'GET /preview/ads.json': (req, res) => {
      const manifest = sync.getManifest();
      if (!manifest) throw new AppError(503, 'No scan has finished yet.');
      sendJson(res, 200, manifest);
    },
  };

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/healthz') return sendJson(res, 200, { ok: true });
      if (!isAuthorized(req, config.adminUser, config.adminPassword)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="TV ads admin", charset="UTF-8"' });
        return res.end('Sign in required');
      }
      const handler = routes[`${req.method} ${url.pathname}`];
      if (!handler) throw new AppError(404, `Nothing at ${req.method} ${url.pathname}`);
      await handler(req, res, url);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) log.error(`${req.method} ${url.pathname}: ${err.stack || err.message}`);
      if (res.headersSent) return res.destroy();
      // If we refused an upload before reading it, read and discard the rest so the browser
      // receives this error (closing the connection early shows up as "connection dropped" on Windows).
      if (!req.complete) req.resume();
      sendJson(res, status, { error: status >= 500 && !err.status ? 'Something went wrong on the server. Check the backend log.' : err.message, hint: err.hint || null });
    }
  });
}