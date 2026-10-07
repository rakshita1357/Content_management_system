// Protections for the admin side of the backend.

const WEAK = new Set(['', 'change-me', 'changeme', 'password', 'admin', 'letmein', '12345678']);

export function isWeakPassword(password) {
  const text = String(password || '');
  return text.length < 8 || WEAK.has(text.toLowerCase());
}

/**
 * Which address to listen on. An explicit HOST always wins. Otherwise a strong admin password allows the
 * local network (the TVs must reach us); a missing or placeholder password keeps the backend on this computer only.
 */
export function chooseHost(config) {
  if (config.host) return config.host;
  return isWeakPassword(config.adminPassword) ? '127.0.0.1' : '0.0.0.0';
}

/** After `max` wrong passwords within `windowMs`, that address is refused for `lockMs`. A right password clears the count. */
export function createLoginLimiter({ max = 10, windowMs = 600_000, lockMs = 600_000, now = Date.now } = {}) {
  const entries = new Map(); // ip -> { fails: [times], lockedUntil }
  const prune = () => {
    if (entries.size < 5000) return;
    const t = now();
    for (const [ip, e] of entries) if (e.lockedUntil < t && e.fails.every((f) => t - f > windowMs)) entries.delete(ip);
  };
  return {
    check(ip) {
      const e = entries.get(ip);
      const t = now();
      if (e && e.lockedUntil > t) return { blocked: true, retryAfterSec: Math.ceil((e.lockedUntil - t) / 1000) };
      return { blocked: false, retryAfterSec: 0 };
    },
    fail(ip) {
      prune();
      const t = now();
      const e = entries.get(ip) || { fails: [], lockedUntil: 0 };
      e.fails = e.fails.filter((f) => t - f < windowMs);
      e.fails.push(t);
      if (e.fails.length >= max) { e.lockedUntil = t + lockMs; e.fails = []; }
      entries.set(ip, e);
    },
    ok(ip) { entries.delete(ip); },
  };
}

/** True when a browser says the request comes from another site (it cached our Basic login and a hostile page used it). */
export function isCrossSite(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host !== req.headers.host;
  } catch {
    return true;
  }
}
