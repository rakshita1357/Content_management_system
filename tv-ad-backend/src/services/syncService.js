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

  async function scan() {
    const rootChildren = await reader.listChildren(config.rootFolderId);
    const folderChildren = new Map();
    for (const folder of rootChildren.filter((f) => f.mimeType === FOLDER_MIME)) {
      folderChildren.set(folder.id, await reader.listChildren(folder.id));
    }
    const manifest = buildManifest({
      rootFolderId: config.rootFolderId,
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

  // The scan may run as the signed-in account (private folder OK), but the TV only has the API key.
  // If the key sees fewer items in the root than the account does, tell the admin the folder is not public.
  async function checkTvAccess(manifest) {
    if (!reader.usesOAuth || !reader.listChildrenPublic) return null;
    const expected = manifest.summary.adFolders.length + manifest.skipped.filter((s) => !s.adName).length;
    if (!expected) return null;
    try {
      const visible = await reader.listChildrenPublic(config.rootFolderId);
      if (visible.length) return null;
    } catch { /* fall through to the warning */ }
    return 'The TV cannot see this Drive folder. In Drive, share it as "Anyone with the link: Viewer", otherwise the TV will not be able to load ads.';
  }

  function publishingStatus() {
    if (!config.publishToDrive) return { enabled: false, reason: 'PUBLISH_TO_DRIVE is false: preview only.' };
    if (!writer) return { enabled: false, reason: 'OAuth is not set up yet, so nothing is written to Drive. See step 5.' };
    return { enabled: true, reason: null };
  }

  async function init() {
    const saved = await store.load();
    state.publishedRevision = saved.publishedRevision || null;
    state.lastPublishAt = saved.lastPublishAt || null;
  }

  function sync({ reason = 'scheduled', force = false } = {}) {
    return exclusive(async () => {
      state.running = true;
      try {
        const manifest = await scan();
        state.manifest = manifest;
        state.indexHtml = renderIndexHtml(manifest);
        state.lastScanAt = now().toISOString();
        state.warning = await checkTvAccess(manifest);

        const changed = manifest.revision !== state.publishedRevision;
        let published = false;
        if (publishingStatus().enabled && (changed || force)) {
          // Page first, manifest last: once ads.json shows a new revision, index.html is already in place.
          await writer.upsertTextFile(config.rootFolderId, PUBLISHED_FILES.page, 'text/html', state.indexHtml);
          await writer.upsertTextFile(config.rootFolderId, PUBLISHED_FILES.manifest, 'application/json', `${JSON.stringify(manifest, null, 2)}\n`);
          state.publishedRevision = manifest.revision;
          state.lastPublishAt = now().toISOString();
          await store.save({ publishedRevision: state.publishedRevision, lastPublishAt: state.lastPublishAt });
          published = true;
        }
        state.lastError = null;
        log.info(`[sync:${reason}] ${manifest.summary.totalAds} ads, revision ${manifest.revision}, ${published ? 'published' : changed ? 'not published' : 'unchanged'}`);
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
      revision: state.manifest?.revision || null,
      publishedRevision: state.publishedRevision,
      publishing: publishingStatus(),
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
    start,
    stop,
    getStatus,
    getManifest: () => state.manifest,
    getIndexHtml: () => state.indexHtml,
  };
}
