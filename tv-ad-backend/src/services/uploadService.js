import { MEDIA_TYPES } from '../config.js';
import { AppError } from '../lib/errors.js';

const EXTENSIONS = { 'video/mp4': ['.mp4', '.m4v'], 'image/jpeg': ['.jpg', '.jpeg'], 'image/png': ['.png'] };

export function cleanAdName(raw) {
  const name = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!name) throw new AppError(400, 'Give the ad a name. It becomes the subfolder name in Drive.');
  if (name.length > 80) throw new AppError(400, 'Keep the ad name under 80 characters.');
  if (/[\\/]/.test(name)) throw new AppError(400, 'The ad name cannot contain / or \\.');
  return name;
}

/** Validates the upload, puts it in the ad's subfolder (created if new), then re-syncs. */
export function createUploadService({ config, writer, sync }) {
  async function upload({ adName, fileName, mimeType, size, stream }) {
    if (!writer) {
      throw new AppError(503, 'Uploading needs Drive write access, which is not set up yet.', 'Complete step 5 (npm run auth) and restart the backend.');
    }
    const source = sync.getSource();
    if (!source) throw new AppError(409, 'No Drive folder is connected yet.', 'Paste a Drive folder link on the admin page first.');
    if (source.canWrite === false) {
      throw new AppError(403, 'This Drive folder is view-only for the signed-in Google account, so uploads are not possible.', 'Ask the owner for edit access, or add files to the folder in Drive directly.');
    }
    const folderName = cleanAdName(adName);
    const name = String(fileName || '').trim();
    if (!name) throw new AppError(400, 'The file has no name.');
    if (!MEDIA_TYPES[mimeType]) {
      throw new AppError(415, `"${name}" is ${mimeType || 'an unknown type'}. Upload an MP4 video or a JPG or PNG image.`);
    }
    const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
    if (!EXTENSIONS[mimeType].includes(ext)) {
      throw new AppError(415, `"${name}" does not have a ${EXTENSIONS[mimeType].join(' or ')} extension.`);
    }
    if (!Number.isFinite(size) || size <= 0) throw new AppError(411, 'The upload has no size. Try again from the admin page.');
    if (size > config.maxUploadMb * 1024 * 1024) {
      throw new AppError(413, `"${name}" is ${(size / 1048576).toFixed(0)} MB. The limit is ${config.maxUploadMb} MB.`,
        'TV storage is limited. Re-encode the video at 1080p, H.264, around 8 Mbps.');
    }

    const folder = await writer.ensureFolder(source.folderId, folderName);
    const file = await writer.uploadStream({ parentId: folder.id, name, mimeType, size, stream });

    // The file is safely in Drive at this point; a failed sync is reported but does not fail the upload.
    let syncResult = null;
    let syncError = null;
    try {
      syncResult = await sync.sync({ reason: 'upload' });
    } catch (err) {
      syncError = { message: err.message, hint: err.hint || null };
    }
    return { file, adName: folderName, folderCreated: folder.created, sync: syncResult, syncError };
  }
  return { upload };
}
