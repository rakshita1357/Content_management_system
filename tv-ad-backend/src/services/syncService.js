import { FOLDER_MIME, PUBLISHED_FILES } from '../config.js';
import { AppError } from '../lib/errors.js';
import { buildManifest } from '../manifest/buildManifest.js';
import { validateManifest } from '../manifest/validate.js';
import { renderIndexHtml } from '../manifest/renderIndexHtml.js';

/**
 * Scan Drive -> build ads.json + index.html -> publish to Drive only if the revision changed.
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
    warning: null,
    manifest: null,
    indexHtml: null,
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
  }

  const persist = () => store.save({ publishedRevision: state.publishedRevision, lastPublishAt: state.lastPublishAt, source: state.source });

  // Switches to another Drive folder. The caller runs a sync afterwards.
  async function setSource(source) {
    state.source = source;
    state.publishedRevision = null;
    state.manifest = null;
    state.indexHtml = null;
    state.warning = null;
    state.lastError = null;
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
        state.manifest = manifest;
        state.indexHtml = renderIndexHtml(manifest);
        state.lastScanAt = now().toISOString();

        const changed = manifest.revision !== state.publishedRevision;
        let published = false;
        state.warning = null;
        if (publishingStatus().enabled && (changed || force)) {
          // Optional copy of ads.json/index.html in Drive. The TV does not read it, so a failure here
          // (for example a view-only folder) is reported as a warning and never blocks the scan.
          try {
            // Page first, manifest last: once ads.json shows a new revision, index.html is already in place.
            await writer.upsertTextFile(state.source.folderId, PUBLISHED_FILES.page, 'text/html', state.indexHtml);
            await writer.upsertTextFile(state.source.folderId, PUBLISHED_FILES.manifest, 'application/json', `${JSON.stringify(manifest, null, 2)}\n`);
            state.publishedRevision = manifest.revision;
            state.lastPublishAt = now().toISOString();
            await persist();
            published = true;
          } catch (err) {
            state.warning = `Could not save ads.json/index.html to Drive: ${err.message}${err.hint ? ` (${err.hint})` : ''}. Playback is not affected.`;
            log.error(`[sync:${reason}] publish to Drive failed: ${err.message}`);
          }
        }
        state.lastError = null;
        log.info(`[sync:${reason}] ${manifest.summary.totalAds} ads, revision ${manifest.revision}, ${published ? 'published to Drive' : changed ? 'new revision' : 'unchanged'}`);
        return { revision: manifest.revision, changed, published, totalAds: manifest.summary.totalAds, skipped: manifest.skipped.length };
      } catch (err) {
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
      state.nextSyncAt = new Date(Date.now() + config.syncIntervalSec * 1000).toISOString();
      timer = setTimeout(() => sync().catch(() => {}).finally(tick), config.syncIntervalSec * 1000);
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
    getIndexHtml: () => state.indexHtml,
  };
}
