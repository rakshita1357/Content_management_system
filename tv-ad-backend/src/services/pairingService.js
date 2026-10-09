import { randomInt } from 'node:crypto';
import { AppError } from '../lib/errors.js';

// No 0/O, 1/I/L: a code read off a TV across the room must not be ambiguous.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const LENGTH = 6;
const normalize = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Short-lived codes that link a TV to a person at the admin page: the TV asks for a code and shows it, the admin types it in.
 * Codes live in memory only (a restart simply makes the TV ask again), expire, and the number waiting is capped, because
 * the TV side of this is a public route.
 */
export function createPairingService({ now = () => Date.now(), ttlMs = 15 * 60_000, max = 500 } = {}) {
  const byCode = new Map();   // code -> { screenId, expires }
  const byScreen = new Map(); // screenId -> code

  function sweep(t) {
    for (const [code, entry] of byCode) {
      if (entry.expires <= t) { byCode.delete(code); if (byScreen.get(entry.screenId) === code) byScreen.delete(entry.screenId); }
    }
  }

  // The code this screen should show. The same one until it expires, so it does not change while someone is typing it.
  function codeFor(screenId) {
    const t = now();
    sweep(t);
    const existing = byScreen.get(screenId);
    if (existing && byCode.has(existing)) return { code: existing, expiresInSec: Math.round((byCode.get(existing).expires - t) / 1000) };
    if (byCode.size >= max) throw new AppError(503, 'Too many screens are waiting to be paired. Try again in a few minutes.');
    let code;
    do { code = Array.from({ length: LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join(''); } while (byCode.has(code));
    byCode.set(code, { screenId, expires: t + ttlMs });
    byScreen.set(screenId, code);
    return { code, expiresInSec: Math.round(ttlMs / 1000) };
  }

  // The screen a typed code belongs to, or an error that says what to do.
  function lookup(input) {
    const code = normalize(input);
    sweep(now());
    const entry = byCode.get(code);
    if (!entry) throw new AppError(404, 'That pairing code was not found or has expired.', 'Look at the code on the TV again (it changes every 15 minutes) and type it exactly.');
    return entry.screenId;
  }

  function release(screenId) {
    const code = byScreen.get(screenId);
    if (code) byCode.delete(code);
    byScreen.delete(screenId);
  }

  return { codeFor, lookup, release };
}
