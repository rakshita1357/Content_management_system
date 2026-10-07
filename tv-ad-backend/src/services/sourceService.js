import { parseFolderInput } from '../drive/parseFolderLink.js';
import { AppError } from '../lib/errors.js';
import { FOLDER_MIME } from '../config.js';

/** Validates a pasted Drive folder link, then makes it the folder the TV plays from. */
export function createSourceService({ reader, sync }) {
  async function inspect(input) {
    const folderId = parseFolderInput(input);
    const folder = await reader.getFolder(folderId);
    if (folder.mimeType !== FOLDER_MIME) {
      throw new AppError(400, `"${folder.name}" is a file, not a folder.`, 'Open the folder that contains it and paste that link.');
    }
    if (folder.trashed) throw new AppError(400, `The folder "${folder.name}" is in the Drive trash.`, 'Restore it in Drive, or paste a different folder.');

    const manifest = await sync.previewFolder(folderId);
    const rootFiles = manifest.skipped.filter((s) => !s.adName).length;
    const warnings = [];
    if (!manifest.summary.adFolders.length) {
      warnings.push('This folder has no subfolders yet. Each ad needs its own subfolder. You can upload ads from this page.');
    } else if (!manifest.summary.totalAds) {
      warnings.push('The subfolders contain no MP4, JPG or PNG files yet.');
    }
    if (rootFiles) warnings.push(`${rootFiles} file${rootFiles === 1 ? '' : 's'} directly in the main folder will be ignored. Move them into a subfolder.`);

    return {
      source: { folderId, folderName: folder.name, canWrite: Boolean(reader.usesOAuth && folder.capabilities?.canAddChildren) },
      summary: manifest.summary,
      skipped: manifest.skipped,
      warnings,
    };
  }

  const currentOf = () => sync.getSource();
  const hasAds = () => (sync.getManifest()?.ads.length || 0) > 0;

  // Validates a link and says what choosing it would do. Changes nothing.
  async function check(input) {
    const info = await inspect(input);
    const current = currentOf();
    const same = Boolean(current && current.folderId === info.source.folderId);
    return {
      ...info,
      same,
      current: current ? { folderName: current.folderName } : null,
      // Replacing a folder whose ads are known (and saved on TVs) needs the user's confirmation.
      requiresConfirm: Boolean(current && !same && hasAds()),
    };
  }

  // Makes the folder the active one. Same folder: just a sync, nothing is reset. A different folder while ads exist:
  // refused unless the caller confirms with replace: true, and the new folder must have ads, so a wrong link can
  // never replace a working playlist with nothing.
  async function apply(input, { replace = false } = {}) {
    const info = await check(input);
    if (info.same) {
      let syncResult = null;
      let syncError = null;
      try {
        syncResult = await sync.sync({ reason: 'source' });
      } catch (err) {
        syncError = { message: err.message, hint: err.hint || null };
      }
      return { ...info, unchanged: true, sync: syncResult, syncError };
    }
    if (info.requiresConfirm) {
      if (!replace) {
        throw new AppError(409, `This would replace the current folder "${info.current.folderName || 'current folder'}".`,
          'Confirm the change to continue.', 'CONFIRM_REQUIRED');
      }
      if (!info.summary.totalAds) {
        throw new AppError(400, `"${info.source.folderName}" has no supported ads (MP4, JPG or PNG inside subfolders), so the current ads were kept.`,
          'Add ads to the new folder first, or paste a different link.', 'NO_ADS');
      }
    }
    await sync.setSource(info.source);
    let syncResult = null;
    let syncError = null;
    try {
      syncResult = await sync.sync({ reason: 'source', force: true });
    } catch (err) {
      syncError = { message: err.message, hint: err.hint || null };
    }
    return { ...info, sync: syncResult, syncError };
  }

  return { inspect, check, apply };
}
