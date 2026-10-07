import { timingSafeEqual } from 'node:crypto';

export function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

export function sendText(res, status, contentType, body) {
  res.writeHead(status, { 'Content-Type': `${contentType}; charset=utf-8`, 'Cache-Control': 'no-store' });
  res.end(body);
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// HTTP Basic auth. With no ADMIN_PASSWORD set, the admin page is open (only OK on a private network).
export function isAuthorized(req, user, password) {
  if (!password) return true;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  if (sep < 0) return false;
  return safeEqual(decoded.slice(0, sep), user) && safeEqual(decoded.slice(sep + 1), password);
}
