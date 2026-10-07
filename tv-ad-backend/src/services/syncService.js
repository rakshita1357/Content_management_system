import { FOLDER_MIME, PUBLISHED_FILES } from '../config.js';
import { AppError } from '../lib/errors.js';
import { buildManifest, diffManifests } from '../manifest/buildManifest.js';
import { validateManifest } from '../manifest/validate.js';

// After a failed sync, try again soon (30 s, 1 min, 2 min, ...) instead of waiting the whole interval.
export function nextDelayMs(failures, intervalSec) {
  const full = intervalSec * 1000;
  if (!failures) return full;
  return Math.min(full, 30_000 * 2 ** (failures - 1));
}

/**
 * Scan Drive -> build ads.json -> publish to Drive only if the revision changed.
 * Runs on a timer (SYNC_INTERVAL_SEC) and on demand (upload, "Sync now").
 */
export function createSyncService({ config, reader, writer, store, log = console, now = () => new Date() }) {
  const state = {
    running: false,
    lastScanAt: null,
    lastPublishAt: null,
    nextSyncAt: null,
    publishedRevision: null,
    source: null, // { folderId, folderName, canWrite } the ads are read from
    lastError: null,
    lastSuccessAt: null,
    failures: 0,          // consecutive failed syncs
    emptyStreak: 0,       // consecutive scans that found no ads while ads were known
    lastChange: null,     // { at, revision, added, modified, removed }
    fromDisk: false,      // the ad list was restored from disk and not yet confirmed by a scan
    warning: null,
    manifest: null,
  };
  let queue = Promise.resolve();
  let timer = null;

  // One sync at a time; later requests wait their turn.
  const exclusive = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  async function scan(folderId = state.source.folderId) {
    const rootChildren = await reader.listChildren(folderId);
    const folderChildren = new Map();
    for (const folder of rootChildren.filter((f) => f.mimeType === FOLDER_MIME)) {
      folderChildren.set(folder.id, await reader.listChildren(folder.id));
    }
    const manifest = buildManifest({
      rootFolderId: folderId,
      rootChildren,
      folderChildren,
      imageDurationSec: config.imageDurationSec,
      syncIntervalSec: config.syncIntervalSec,
      now: now(),
    });
    const errors = validateManifest(manifest);
    if (errors.length) throw new AppError(500, `Generated ads.json is invalid: ${errors.join('; ')}`);
    return manifest;
  }

  function publishingStatus() {
    if (!config.publishToDrive) return { enabled: false, reason: null };
    if (!writer) return { enabled: false, reason: 'OAuth is not set up, so nothing can be written to Drive.' };
    if (state.source?.canWrite === false) return { enabled: false, reason: null };
    return { enabled: true, reason: null };
  }

  async function init() {
    const saved = await store.load();
    state.publishedRevision = saved.publishedRevision || null;
    state.lastPublishAt = saved.lastPublishAt || null;
    // A folder chosen in the admin page wins over DRIVE_FOLDER_ID in .env.
    state.source = saved.source
      || (config.rootFolderId ? { folderId: config.rootFolderId, folderName: null, canWrite: Boolean(writer) } : null);
    // Serve the last good ad list straight away, even if Drive or the internet is down right now.
    const kept = state.source ? await store.loadManifest() : null;
    if (kept && kept.source?.folderId === state.source.folderId && Array.isArray(kept.ads)) {
      state.manifest = kept;
      state.fromDisk = true;
    }
  }

  const persist = () => store.save({ publishedRevision: state.publishedRevision, lastPublishAt: state.lastPublishAt, source: state.source });

  // Switches to another Drive folder. The caller runs a sync afterwards.
  async function setSource(source) {
    state.source = source;
    state.publishedRevision = null;
    state.manifest = null;
    state.fromDisk = false;
    state.emptyStreak = 0;
    state.failures = 0;
    state.lastChange = null;
    state.warning = null;
    state.lastError = null;
    await store.saveManifest(null);
    await persist();
  }

  function sync({ reason = 'scheduled', force = false } = {}) {
    return exclusive(async () => {
      if (!state.source) {
        // Nothing to scan until a folder is chosen in the admin page.
        state.lastScanAt = now().toISOString();
        return { needsSetup: true, revision: null, changed: false, published: false, totalAds: 0, skipped: 0 };
      }
      state.running = true;
      try {
        const manifest = await scan();
        state.lastScanAt = now().toISOString();

        // A scan that suddenly finds nothing is more likely a Drive hiccup than every ad being deleted, and
        // acting on it would make TVs throw away their saved files. Keep the old list until a second scan agrees
        // ("Sync now" is a deliberate request and is trusted at once).
        const previous = state.manifest;
        if (!force && previous?.ads.length && !manifest.ads.length && state.emptyStreak < 1) {
          state.emptyStreak++;
          state.warning = 'Drive returned no ads this time. The previous list is kept until the next check confirms it.';
          state.lastError = null;
          state.failures = 0;
          state.lastSuccessAt = now().toISOString();
          log.info(`[sync:${reason}] 0 ads found but ${previous.ads.length} were known: keeping the previous list until the next check`);
          return { revision: previous.revision, changed: false, published: false, totalAds: previous.ads.length, skipped: previous.skipped.length, heldBack: true };
        }
        state.emptyStreak = 0;

        const delta = diffManifests(previous, manifest);
        const changedList = manifest.revision !== previous?.revision;
        state.manifest = manifest;
        state.fromDisk = false;
        if (changedList) {
          if (previous) state.lastChange = { at: now().toISOString(), revision: manifest.revision, ...delta };
          await store.saveManifest(manifest);
        }

        const changed = manifest.revision !== state.publishedRevision;
        let published = false;
        state.warning = null;
        if (publishingStatus().enabled && (changed || force)) {
          // Optional copy of ads.json in Drive. The TV does not read it, so a failure here
          // (for example a view-only folder) is reported as a warning and never blocks the scan.
          try {
            await writer.upsertTextFile(state.source.folderId, PUBLISHED_FILES.manifest, 'application/json', `${JSON.stringify(manifest, null, 2)}\n`);
            state.publishedRevision = manifest.revision;
            state.lastPublishAt = now().toISOString();
            await persist();
            published = true;
          } catch (err) {
            state.warning = `Could not save ads.json to Drive: ${err.message}${err.hint ? ` (${err.hint})` : ''}. Playback is not affected.`;
            log.error(`[sync:${reason}] publish to Drive failed: ${err.message}`);
          }
        }
        state.lastError = null;
        state.failures = 0;
        state.lastSuccessAt = now().toISOString();
        const what = changedList && previous ? ` (+${delta.added} added, ${delta.modified} changed, -${delta.removed} removed)` : '';
        log.info(`[sync:${reason}] ${manifest.summary.totalAds} ads, revision ${manifest.revision}, ${published ? 'published to Drive' : changed ? 'new revision' : 'unchanged'}${what}`);
        return { revision: manifest.revision, changed, published, totalAds: manifest.summary.totalAds, skipped: manifest.skipped.length };
      } catch (err) {
        state.failures++;
        state.lastError = { message: err.message, hint: err.hint || null, at: now().toISOString() };
        log.error(`[sync:${reason}] failed: ${err.message}${err.hint ? ` (${err.hint})` : ''}`);
        throw err;
      } finally {
        state.running = false;
      }
    });
  }

  function start() {
    const tick = () => {
      const wait = nextDelayMs(state.failures, config.syncIntervalSec);
      state.nextSyncAt = new Date(Date.now() + wait).toISOString();
      timer = setTimeout(() => sync().catch(() => {}).finally(tick), wait);
    };
    sync({ reason: 'startup' }).catch(() => {}).finally(tick);
  }

  function stop() {
    clearTimeout(timer);
    timer = null;
  }

  function getStatus() {
    return {
      running: state.running,
      lastScanAt: state.lastScanAt,
      lastSuccessAt: state.lastSuccessAt,
      failures: state.failures,
      lastChange: state.lastChange,
      fromDisk: state.fromDisk,
      lastPublishAt: state.lastPublishAt,
      nextSyncAt: state.nextSyncAt,
      needsSetup: !state.source,
      source: state.source,
      revision: state.manifest?.revision || null,
      publishedRevision: state.publishedRevision,
      publishing: publishingStatus(),
      canUpload: Boolean(writer) && state.source?.canWrite !== false,
      lastError: state.lastError,
      warning: state.warning,
      summary: state.manifest?.summary || null,
      settings: {
        imageDurationSec: config.imageDurationSec,
        syncIntervalSec: config.syncIntervalSec,
        maxUploadMb: config.maxUploadMb,
      },
    };
  }

  return {
    init,
    sync,
    setSource,
    getSource: () => state.source,
    previewFolder: (folderId) => scan(folderId),
    start,
    stop,
    getStatus,
    getManifest: () => state.manifest,
    getHealth: () => ({
      ok: true,
      needsSetup: !state.source,
      ads: state.manifest?.ads.length ?? 0,
      revision: state.manifest?.revision ?? null,
      lastSuccessAt: state.lastSuccessAt,
      syncOk: state.failures < 3,   // false after three failed syncs in a row
    }),
  };
}
