import { FOLDER_MIME } from '../config.js';
import { AppError, driveError } from '../lib/errors.js';

const escapeQuery = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

// Everything that changes Drive goes through here, authenticated as you via OAuth.
export function createDriveWriter({ urls }, tokens, fetchImpl = fetch) {
  async function authed(url, init = {}) {
    const token = await tokens.getAccessToken();
    return fetchImpl(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } });
  }

  async function findChild(parentId, name, mimeType) {
    const q = [`'${parentId}' in parents`, `name = '${escapeQuery(name)}'`, 'trashed = false'];
    if (mimeType) q.push(`mimeType = '${mimeType}'`);
    const params = new URLSearchParams({
      q: q.join(' and '),
      fields: 'files(id,name,mimeType)',
      orderBy: 'createdTime',
      pageSize: '10',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    const res = await authed(`${urls.driveApi}/files?${params}`);
    if (!res.ok) throw await driveError(res, `look for "${name}"`);
    const { files = [] } = await res.json();
    return files[0] || null;
  }

  async function createMetadata(body, action) {
    const res = await authed(`${urls.driveApi}/files?supportsAllDrives=true&fields=id,name`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await driveError(res, action);
    return res.json();
  }

  // Returns the ad subfolder, creating it on first upload.
  async function ensureFolder(parentId, name) {
    const existing = await findChild(parentId, name, FOLDER_MIME);
    if (existing) return { id: existing.id, created: false };
    const created = await createMetadata({ name, mimeType: FOLDER_MIME, parents: [parentId] }, `create the folder "${name}"`);
    return { id: created.id, created: true };
  }

  // Creates or overwrites a small file (ads.json, index.html). Updating keeps the same file ID,
  // so the TV can always fetch the same link.
  async function upsertTextFile(parentId, name, mimeType, content) {
    const existing = await findChild(parentId, name);
    const id = existing?.id || (await createMetadata({ name, mimeType, parents: [parentId] }, `create ${name}`)).id;
    const res = await authed(`${urls.driveUpload}/files/${id}?uploadType=media&supportsAllDrives=true&fields=id,modifiedTime`, {
      method: 'PATCH',
      headers: { 'Content-Type': `${mimeType}; charset=UTF-8` },
      body: content,
    });
    if (!res.ok) throw await driveError(res, `write ${name}`);
    return { ...(await res.json()), created: !existing };
  }

  // Streams a large file straight to Drive with a resumable upload session (no temp file on disk).
  async function uploadStream({ parentId, name, mimeType, size, stream }) {
    const start = await authed(
      `${urls.driveUpload}/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,mimeType,size,createdTime`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': mimeType,
          'X-Upload-Content-Length': String(size),
        },
        body: JSON.stringify({ name, parents: [parentId] }),
      },
    );
    if (!start.ok) throw await driveError(start, `start uploading ${name}`);
    const sessionUrl = start.headers.get('location');
    if (!sessionUrl) throw new AppError(502, 'Google Drive did not return an upload address. Try again.');
    const res = await fetchImpl(sessionUrl, {
      method: 'PUT',
      headers: { 'Content-Type': mimeType, 'Content-Length': String(size) },
      body: stream,
      duplex: 'half',
    });
    if (!res.ok) throw await driveError(res, `upload ${name}`);
    return res.json();
  }

  return { findChild, ensureFolder, upsertTextFile, uploadStream };
}
