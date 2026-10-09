import { createSyncService } from './syncService.js';

/**
 * One sync per Drive folder. The folder chosen on the front page keeps using the main sync; every other folder that a
 * screen has been assigned to gets its own (own timer, own saved state), created when it is first needed.
 */
export function createFolderHub({ config, reader, writer, store, mainSync, log = console, makeSync = createSyncService }) {
  const extra = new Map();   // folderId -> sync service

  const isMain = (folderId) => mainSync.getSource()?.folderId === folderId;

  // Makes sure the folder is being synced and returns its sync service. With wait: true the first scan has finished (or
  // failed) before this returns, so a TV that was just given the folder gets its ads straight away.
  async function ensure(source, { wait = false } = {}) {
    if (isMain(source.folderId)) return mainSync;
    if (extra.has(source.folderId)) return extra.get(source.folderId);
    const sync = makeSync({ config: { ...config, rootFolderId: source.folderId }, reader, writer, store: store.scoped(source.folderId), log });
    extra.set(source.folderId, sync);
    await sync.init();   // restores this folder's saved ad list, if there is one
    if (wait) {
      await sync.sync({ reason: 'assign', force: true }).catch(() => {});   // the failure shows on the screen's list, not here
      sync.start({ first: false });
    } else {
      sync.start();   // first scan right away, then every interval
    }
    return sync;
  }

  // The sync service that serves a screen, or null when the screen plays the main folder.
  async function forScreen(screen) {
    if (!screen?.folderId) return null;
    return ensure({ folderId: screen.folderId, folderName: screen.folderName });
  }

  // Stops syncing a folder that no screen uses any more.
  function releaseUnused(screens) {
    const used = new Set(screens.filter((s) => s.folderId).map((s) => s.folderId));
    for (const [folderId, sync] of extra) {
      if (!used.has(folderId)) { sync.stop(); extra.delete(folderId); }
    }
  }

  const all = () => [mainSync, ...extra.values()];
  const findAd = (id) => all().map((s) => s.getManifest()?.ads.find((a) => a.id === id)).find(Boolean) || null;
  const stopAll = () => { for (const sync of extra.values()) sync.stop(); };

  return { ensure, forScreen, releaseUnused, findAd, all, stopAll, count: () => extra.size };
}
