// A tiny in-memory imitation of the Drive v3 + OAuth endpoints the backend uses.
import http from 'node:http';
import { FOLDER } from './fixtures.js';

export function startFakeGoogle({ apiKey, root, children, rootId }) {
  const files = new Map();
  const add = (f, parent) => files.set(f.id, { ...f, parents: [parent], trashed: false });
  root.forEach((f) => add(f, rootId));
  for (const [pid, list] of children) list.forEach((f) => add(f, pid));
  const bodies = new Map();
  const calls = [];
  let seq = 0;
  let clock = Date.parse('2026-10-01T00:00:00Z');
  const tick = () => new Date((clock += 1000)).toISOString();
  const authed = (req) => req.headers.authorization === 'Bearer test-access-token';
  const read = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
  const json = (res, status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    calls.push(`${req.method} ${url.pathname}`);
    if (url.pathname === '/token') return json(res, 200, { access_token: 'test-access-token', expires_in: 3600 });

    if (req.method === 'GET' && url.pathname === '/drive/v3/files') {
      if (url.searchParams.get('key') !== apiKey && !authed(req)) return json(res, 400, { error: { message: 'API key not valid. Please pass a valid API key.' } });
      const q = url.searchParams.get('q');
      const parent = q.match(/'([^']+)' in parents/)[1];
      const name = q.match(/name = '((?:[^'\\]|\\.)*)'/)?.[1]?.replace(/\\'/g, "'");
      const mime = q.match(/mimeType = '([^']+)'/)?.[1];
      if (parent !== rootId && !files.has(parent)) return json(res, 404, { error: { message: 'File not found' } });
      const list = [...files.values()].filter((f) => f.parents[0] === parent && !f.trashed
        && (!name || f.name === name) && (!mime || f.mimeType === mime));
      return json(res, 200, { files: list.map(({ parents, trashed, ...f }) => f) });
    }
    // Like Google, the upload session URL itself is the credential.
    if (req.method === 'PUT' && url.pathname.startsWith('/session/')) {
      const s = server.sessions.get(url.pathname.split('/').pop());
      const data = await read(req);
      if (data.length !== s.size) return json(res, 400, { error: { message: 'size mismatch' } });
      const f = { id: `up${++seq}`, name: s.meta.name, mimeType: s.type, size: String(data.length), md5Checksum: 'x', createdTime: tick(), modifiedTime: tick() };
      add(f, s.meta.parents[0]);
      return json(res, 200, { id: f.id, name: f.name, mimeType: f.mimeType, size: f.size, createdTime: f.createdTime });
    }
    if (!authed(req)) return json(res, 401, { error: { message: 'Invalid Credentials' } });

    if (req.method === 'POST' && url.pathname === '/drive/v3/files') {
      const meta = JSON.parse(await read(req));
      const f = { id: `new${++seq}`, name: meta.name, mimeType: meta.mimeType, createdTime: tick(), modifiedTime: tick() };
      add(f, meta.parents[0]);
      return json(res, 200, { id: f.id, name: f.name });
    }
    if (req.method === 'PATCH' && url.pathname.startsWith('/upload/drive/v3/files/')) {
      const id = url.pathname.split('/').pop();
      bodies.set(id, (await read(req)).toString());
      files.get(id).modifiedTime = tick();
      return json(res, 200, { id, modifiedTime: files.get(id).modifiedTime });
    }
    if (req.method === 'POST' && url.pathname === '/upload/drive/v3/files' && url.searchParams.get('uploadType') === 'resumable') {
      const meta = JSON.parse(await read(req));
      const session = `s${++seq}`;
      server.sessions.set(session, { meta, type: req.headers['x-upload-content-type'], size: Number(req.headers['x-upload-content-length']) });
      const { port } = server.address();
      res.writeHead(200, { Location: `http://127.0.0.1:${port}/session/${session}` });
      return res.end();
    }
    json(res, 404, { error: { message: `fake: no route ${req.method} ${url.pathname}` } });
  });
  server.sessions = new Map();
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, files, bodies, calls, base: `http://127.0.0.1:${server.address().port}` })));
}
