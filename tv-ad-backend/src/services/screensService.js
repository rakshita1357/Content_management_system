import { AppError } from '../lib/errors.js';

const ID = /^[A-Za-z0-9_-]{8,64}$/;
const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);
const count = (v) => (Number.isFinite(v) && v >= 0 ? Math.min(Math.floor(v), 1e15) : 0);

/**
 * Remembers which screens (TVs) have reported in, what they play and how full their offline storage is, so the admin
 * page can show which ones are alive and up to date. Screens report through a public route, so everything is
 * validated, size-limited and capped in number.
 */
export function createScreensService({ now = () => Date.now(), max = 200, minGapMs = 5000, persist = null } = {}) {
  const screens = new Map();
  let savedAt = 0;

  function report(body) {
    if (!body || typeof body !== 'object') throw new AppError(400, 'Report must be a JSON object.');
    if (!ID.test(String(body.id || ''))) throw new AppError(400, 'Screen id must be 8 to 64 letters, digits, - or _.');
    const t = now();
    const previous = screens.get(body.id);
    if (previous && t - previous.lastSeen < minGapMs) return { throttled: true };
    screens.set(body.id, {
      // what an admin decided stays: which folder this screen plays and what it is called
      folderId: previous?.folderId || null,
      folderName: previous?.folderName || null,
      label: previous?.label || null,
      pairedAt: previous?.pairedAt || null,
      id: body.id,
      name: text(body.name, 60),
      kind: body.kind === 'android' ? 'android' : 'browser',
      version: text(body.version, 40),
      online: body.online !== false,
      playing: text(body.playing, 120),
      revision: /^[0-9a-f]{12}$/.test(body.revision || '') ? body.revision : null,
      folder: text(body.folder, 120),
      adsSaved: count(body.adsSaved),
      adsTotal: count(body.adsTotal),
      cacheBytes: count(body.cacheBytes),
      quotaBytes: count(body.quotaBytes),
      firstSeen: previous ? previous.firstSeen : t,
      lastSeen: t,
    });
    if (screens.size > max) {
      // a screen that has been given a folder is never the one forgotten
      const oldest = [...screens.values()].filter((s) => !s.folderId).sort((a, b) => a.lastSeen - b.lastSeen)[0];
      if (oldest) screens.delete(oldest.id);
    }
    if (persist && t - savedAt > 30_000) { savedAt = t; Promise.resolve(persist([...screens.values()])).catch(() => {}); }
    return { throttled: false };
  }

  function list() {
    const t = now();
    return [...screens.values()].sort((a, b) => b.lastSeen - a.lastSeen).map((s) => ({ ...s, lastSeenAt: new Date(s.lastSeen).toISOString(), ageSec: Math.round((t - s.lastSeen) / 1000) }));
  }

  // Gives a screen its own Drive folder (and optionally a name). A screen that has never reported in is created.
  function assign(id, { folderId, folderName, label }) {
    if (!ID.test(String(id || ''))) throw new AppError(400, 'Screen id must be 8 to 64 letters, digits, - or _.');
    const t = now();
    const previous = screens.get(id) || {
      id, name: null, kind: 'browser', version: null, online: true, playing: null, revision: null, folder: null,
      adsSaved: 0, adsTotal: 0, cacheBytes: 0, quotaBytes: 0, firstSeen: t, lastSeen: t,
    };
    const next = { ...previous, folderId, folderName: text(folderName, 120), label: text(label, 60) || previous.label || null, pairedAt: t };
    screens.set(id, next);
    return persistNow();
  }

  function unassign(id) {
    const previous = screens.get(id);
    if (!previous) throw new AppError(404, 'No such screen.');
    screens.set(id, { ...previous, folderId: null, folderName: null, pairedAt: null });
    return persistNow();
  }

  const get = (id) => screens.get(id) || null;
  const persistNow = () => (persist ? Promise.resolve(persist([...screens.values()])).then(() => { savedAt = now(); }) : Promise.resolve());

  function load(rows) {
    for (const r of Array.isArray(rows) ? rows : []) if (r && ID.test(String(r.id || ''))) screens.set(r.id, r);
  }

  return { report, list, load, assign, unassign, get };
}
