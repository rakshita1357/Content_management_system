import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError } from './lib/errors.js';
import { publicManifest } from './manifest/buildManifest.js';
import { isAuthorized, readJson, sendJson, sendText } from './lib/http.js';
import { createLoginLimiter, isCrossSite } from './lib/security.js';
import { appVersion, createWebVersion } from './lib/version.js';
import { createScreensService } from './services/screensService.js';

const ADMIN_PAGE = new URL('../public/admin.html', import.meta.url);
const START_PAGE = new URL('../public/start.html', import.meta.url);

/**
 * Routes
 *   GET  /healthz, /api/health liveness check (no login)
 *   GET  /tv/                  the TV page (static files from web-core/): details table, then the player (no login)
 *   GET  /tv/ads.json          current manifest for the TV (no login)
 *   GET  /api/ads/:id/content  streams one ad's media from Drive, supports Range (no login, only ids in ads.json)
 *   GET  /api/ads/:id          one ad's metadata
 *   GET  /admin                admin page
 *   POST /tv/heartbeat         a screen reports in (no login, small and throttled)
 *   GET  /api/screens          which screens reported in, and what they play
 *   GET  /                    start page: one box for a Drive folder link, then on to /tv
 *   GET  /api/status           sync and publishing status
 *   GET  /api/ads              current ads.json
 *   GET  /api/source           the Drive folder in use
 *   POST /api/source/check     {link}: validate a pasted link and say what choosing it would do (changes nothing)
 *   POST /api/source           {link, replace?}: switch to that folder (a different folder needs replace: true)
 *   POST /tv/sync              the TV's "Sync now" button: run a normal sync (no login, at most once per 10 s)
 *   POST /api/sync             rescan Drive and publish now
 *   PUT  /api/upload?adName=&fileName=   raw file body, streamed to Drive
 *   GET  /preview/ads.json     the manifest as it will be published
 */
export function createApp({ config, sync, uploads, sources, reader, screens = createScreensService(), tls = null, limiter = createLoginLimiter(), log: rawLog = console }) {
  // Works with a plain { info, error } logger as well as the full one.
  const log = {
    debug: (m, f) => (rawLog.debug || (() => {})).call(rawLog, m, f),
    info: (m, f) => rawLog.info(m, f),
    warn: (m, f) => (rawLog.warn || rawLog.info).call(rawLog, m, f),
    error: (m, f) => rawLog.error(m, f),
  };
  const webVersion = createWebVersion(config.webCoreDir);
  // Who is calling. Behind N trusted proxies each adds the address it saw to the END of X-Forwarded-For, so the real client
  // is the Nth entry from the end. Entries before that can be made up by the caller and are never trusted.
  const clientIp = (req) => {
    if (config.trustProxy > 0) {
      const chain = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
      const seen = chain[chain.length - config.trustProxy];
      if (seen) return seen;
    }
    return req.socket.remoteAddress || 'unknown';
  };
  // The TV page is a set of static files from web-core/ (the same files a packaged TV app bundles).
  const WEB_CORE_TYPES = {
    'index.html': 'text/html; charset=utf-8',
    'app.css': 'text/css; charset=utf-8',
    'player.js': 'application/javascript; charset=utf-8',
    'config.js': 'application/javascript; charset=utf-8',
    'cache.js': 'application/javascript; charset=utf-8',
  };
  let lastTvSync = 0;
  const webCore = (name) => async (req, res) => {
    let body;
    try {
      body = await readFile(path.join(config.webCoreDir, name));
    } catch {
      throw new AppError(500, `The TV page file ${name} is missing from ${config.webCoreDir}.`);
    }
    res.writeHead(200, { 'Content-Type': WEB_CORE_TYPES[name], 'Cache-Control': 'no-store' });
    res.end(body);
  };
  const tvManifest = (req, res) => {
    const manifest = sync.getManifest();
    if (!manifest) {
      throw new AppError(503, sync.getStatus().needsSetup
        ? 'No Drive folder is connected yet. Open the start page on a computer and paste a folder link.'
        : 'Loading the ads. This page retries automatically.');
    }
    sendJson(res, 200, publicManifest(manifest));
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
    'GET /': async (req, res) => sendText(res, 200, 'text/html', await readFile(START_PAGE, 'utf8')),
    'GET /admin': async (req, res) => sendText(res, 200, 'text/html', await readFile(ADMIN_PAGE, 'utf8')),
    'GET /api/status': (req, res) => sendJson(res, 200, { ...sync.getStatus(), serviceAccountEmail: config.serviceAccount?.email || null }),
    'GET /api/ads': (req, res) => sendJson(res, 200, sync.getManifest() || { ads: [], skipped: [] }),
    'GET /api/screens': (req, res) => sendJson(res, 200, { screens: screens.list(), staleAfterSec: Math.max(3 * config.syncIntervalSec, 600), currentRevision: sync.getManifest()?.revision || null }),
    'GET /api/source': (req, res) => sendJson(res, 200, { source: sync.getSource() }),
    'POST /api/source': async (req, res) => {
      const body = await readJson(req);
      sendJson(res, 200, await sources.apply(body.link, { replace: body.replace === true }));
    },
    'POST /api/source/check': async (req, res) => {
      const body = await readJson(req);
      sendJson(res, 200, await sources.check(body.link));
    },
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
    'GET /preview/ads.json': (req, res) => {
      const manifest = sync.getManifest();
      if (!manifest) throw new AppError(503, 'No scan has finished yet.');
      sendJson(res, 200, manifest);
    },
  };

  // What the TV needs, without the admin login.
  const publicRoutes = {
    'GET /healthz': (req, res) => sendJson(res, 200, { ok: true }),
    'GET /api/health': (req, res) => sendJson(res, 200, { ...sync.getHealth(), version: appVersion, webVersion: webVersion() }),
    // A screen reporting in: what it plays and how full its offline storage is. Small, validated, throttled.
    'POST /tv/heartbeat': async (req, res) => {
      const result = screens.report(await readJson(req, 4096));
      sendJson(res, 200, { ok: true, ...result });
    },
    'GET /tv': (req, res) => { res.writeHead(302, { Location: '/tv/' }); res.end(); },
    'GET /tv/': webCore('index.html'),
    'GET /tv/index.html': webCore('index.html'),
    'GET /tv/app.css': webCore('app.css'),
    'GET /tv/player.js': webCore('player.js'),
    'GET /tv/config.js': webCore('config.js'),
    'GET /tv/cache.js': webCore('cache.js'),
    // The TV's own "Sync now": a normal (not forced) sync, throttled so a remote's key-repeat cannot hammer Drive.
    'POST /tv/sync': async (req, res) => {
      const t = Date.now();
      if (t - lastTvSync < 10_000) return sendJson(res, 200, { throttled: true, ...sync.getHealth() });
      lastTvSync = t;
      try {
        await sync.sync({ reason: 'tv' });
      } catch { /* the failure shows up in health.syncOk and the admin page */ }
      sendJson(res, 200, { throttled: false, ...sync.getHealth() });
    },
    'GET /tv/ads.json': tvManifest,
  };
  const CONTENT = /^\/api\/ads\/([^/]+)\/content$/;
  const ONE_AD = /^\/api\/ads\/([^/]+)$/;

  const handle = async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    if (tls) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
    res.on('finish', () => {
      const line = `${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`;   // never the query string or headers
      if (res.statusCode >= 500) log.error(line);
      else if (res.statusCode === 401 || res.statusCode === 403 || res.statusCode === 429) log.warn(line, { ip: clientIp(req) });
      else log.debug(line);
    });
    try {
      const content = url.pathname.match(CONTENT);
      const open = publicRoutes[`${req.method} ${url.pathname}`];
      // A packaged TV app (webOS, Android TV) loads web-core from its own origin, so the TV routes allow cross-origin reads.
      if (content || open) res.setHeader('Access-Control-Allow-Origin', '*');
      if ((req.method === 'GET' || req.method === 'HEAD') && content) return await streamContent(req, res, decodeURIComponent(content[1]));
      if (open) return await open(req, res);
      const ip = clientIp(req);
      const lock = limiter.check(ip);
      if (lock.blocked) {
        res.writeHead(429, { 'Retry-After': String(lock.retryAfterSec), 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Too many wrong passwords. Try again later.');
      }
      if (!isAuthorized(req, config.adminUser, config.adminPassword)) {
        if (req.headers.authorization) limiter.fail(ip);   // a wrong password counts; the browser's first request without one does not
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="TV ads admin", charset="UTF-8"' });
        return res.end('Sign in required');
      }
      limiter.ok(ip);
      // The browser sends the cached login to any site. A request that another site started must not be able to change anything.
      if (req.method !== 'GET' && req.method !== 'HEAD' && isCrossSite(req)) throw new AppError(403, 'This request came from another website and was refused.');
      const one = req.method === 'GET' && url.pathname.match(ONE_AD);
      if (one) return sendJson(res, 200, findAd(decodeURIComponent(one[1])));
      const handler = routes[`${req.method} ${url.pathname}`];
      if (!handler) throw new AppError(404, `Nothing at ${req.method} ${url.pathname}`);
      await handler(req, res, url);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) log.error(`${req.method} ${url.pathname} failed: ${err.stack || err.message}`);
      if (res.headersSent) return res.destroy();
      // If we refused an upload before reading it, read and discard the rest so the browser
      // receives this error (closing the connection early shows up as "connection dropped" on Windows).
      if (!req.complete) req.resume();
      sendJson(res, status, { error: status >= 500 && !err.status ? 'Something went wrong on the server. Check the backend log.' : err.message, hint: err.hint || null, code: err.code || null });
    }
  };

  return tls ? https.createServer(tls, handle) : http.createServer(handle);
}