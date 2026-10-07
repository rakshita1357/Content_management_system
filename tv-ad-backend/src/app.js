import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError } from './lib/errors.js';
import { isAuthorized, sendJson, sendText } from './lib/http.js';

const ADMIN_PAGE = new URL('../public/admin.html', import.meta.url);

/**
 * Routes
 *   GET  /healthz, /api/health liveness check (no login)
 *   GET  /tv                   the TV page: details table, then the player (no login, TV opens this)
 *   GET  /tv/ads.json          current manifest for the TV (no login)
 *   GET  /api/ads/:id/content  streams one ad's media from Drive, supports Range (no login, only ids in ads.json)
 *   GET  /api/ads/:id          one ad's metadata
 *   GET  /admin                admin page
 *   GET  /api/status           sync and publishing status
 *   GET  /api/ads              current ads.json
 *   POST /api/sync             rescan Drive and publish now
 *   PUT  /api/upload?adName=&fileName=   raw file body, streamed to Drive
 *   GET  /preview/index.html   the TV page as it will be published
 *   GET  /preview/ads.json     the manifest as it will be published
 */
export function createApp({ config, sync, uploads, reader, log = console }) {
  const tvPage = (req, res) => {
    const html = sync.getIndexHtml();
    if (!html) throw new AppError(503, 'No scan has finished yet. Wait a moment and reload.');
    sendText(res, 200, 'text/html', html);
  };
  const tvManifest = (req, res) => {
    const manifest = sync.getManifest();
    if (!manifest) throw new AppError(503, 'No scan has finished yet.');
    sendJson(res, 200, manifest);
  };
  const findAd = (id) => {
    const ad = sync.getManifest()?.ads.find((a) => a.id === id);
    if (!ad) throw new AppError(404, 'No such ad. It may have been removed in the last sync.');
    return ad;
  };

  // Streams the file from Drive using the backend's own credentials. Only ids listed in ads.json are served.
  async function streamContent(req, res, id) {
    const ad = findAd(id);
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    const upstream = await reader.openMedia(ad.id, req.headers.range, abort.signal);
    const headers = { 'Content-Type': ad.mimeType, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
    for (const h of ['content-length', 'content-range']) {
      if (upstream.headers.get(h)) headers[h] = upstream.headers.get(h);
    }
    res.writeHead(upstream.status, headers);
    if (req.method === 'HEAD' || !upstream.body) return res.end();
    await pipeline(Readable.fromWeb(upstream.body), res).catch(() => {});
  }

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
    'GET /preview/index.html': tvPage,
    'GET /preview/ads.json': tvManifest,
  };

  // What the TV needs, without the admin login.
  const publicRoutes = {
    'GET /healthz': (req, res) => sendJson(res, 200, { ok: true }),
    'GET /api/health': (req, res) => sendJson(res, 200, { ok: true }),
    'GET /tv': tvPage,
    'GET /tv/': tvPage,
    'GET /tv/index.html': tvPage,
    'GET /tv/ads.json': tvManifest,
  };
  const CONTENT = /^\/api\/ads\/([^/]+)\/content$/;
  const ONE_AD = /^\/api\/ads\/([^/]+)$/;

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      const content = url.pathname.match(CONTENT);
      if ((req.method === 'GET' || req.method === 'HEAD') && content) return await streamContent(req, res, decodeURIComponent(content[1]));
      const open = publicRoutes[`${req.method} ${url.pathname}`];
      if (open) return await open(req, res);
      if (!isAuthorized(req, config.adminUser, config.adminPassword)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="TV ads admin", charset="UTF-8"' });
        return res.end('Sign in required');
      }
      const one = req.method === 'GET' && url.pathname.match(ONE_AD);
      if (one) return sendJson(res, 200, findAd(decodeURIComponent(one[1])));
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