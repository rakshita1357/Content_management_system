import { AppError, driveError } from '../lib/errors.js';
import { createGoogleFetch } from '../lib/googleFetch.js';

// Lists Drive folders. By default it uses the API key only (exactly the access the TV has).
// When a token provider is passed and OAuth is configured, listChildren() authenticates as the
// signed-in Google account instead, so a PRIVATE folder is scanned correctly.
const FIELDS = [
  'nextPageToken',
  'files(id,name,mimeType,size,md5Checksum,createdTime,modifiedTime,'
    + 'videoMediaMetadata(width,height,durationMillis),imageMediaMetadata(width,height))',
].join(',');

export function createPublicReader({ apiKey, urls, google }, tokens = null, fetchImpl = fetch) {
  const gfetch = createGoogleFetch(google, fetchImpl);
  const useOAuth = Boolean(tokens?.isConfigured());

  async function list(folderId, oauth) {
    const files = [];
    let pageToken;
    do {
      const params = new URLSearchParams({
        q: `'${folderId}' in parents and trashed = false`,
        fields: FIELDS,
        pageSize: '1000',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
      });
      if (!oauth) params.set('key', apiKey);
      if (pageToken) params.set('pageToken', pageToken);
      const init = oauth ? { headers: { Authorization: `Bearer ${await tokens.getAccessToken()}` } } : undefined;
      const res = await gfetch(`${urls.driveApi}/files?${params}`, init);
      if (!res.ok) throw await driveError(res, 'list the folder');
      const body = await res.json();
      files.push(...(body.files || []));
      pageToken = body.nextPageToken;
    } while (pageToken);
    return files;
  }
  // Folder details for validating a pasted link. Throws a readable error when it cannot be opened.
  async function getFolder(folderId) {
    const params = new URLSearchParams({ fields: 'id,name,mimeType,trashed,capabilities(canAddChildren)', supportsAllDrives: 'true' });
    const headers = {};
    if (useOAuth) headers.Authorization = `Bearer ${await tokens.getAccessToken()}`;
    else params.set('key', apiKey);
    const res = await gfetch(`${urls.driveApi}/files/${encodeURIComponent(folderId)}?${params}`, { headers });
    if (res.status === 404 || res.status === 403) {
      throw new AppError(404, 'Google Drive cannot open this folder with the account the backend uses.',
        tokens?.serviceAccountEmail
          ? `Share the folder with ${tokens.serviceAccountEmail} (Viewer is enough), then try again.`
          : useOAuth
          ? 'Check the link, and make sure the folder is yours or shared with the Google account you signed in with (npm run auth).'
          : 'Check the link. Without OAuth the folder must be shared as "Anyone with the link: Viewer".');
    }
    if (!res.ok) throw await driveError(res, 'open the folder');
    return res.json();
  }

  // Opens a media file for streaming to the TV. Passes the Range header through so video can seek.
  async function openMedia(fileId, range, signal) {
    const headers = {};
    if (range) headers.Range = range;
    const params = new URLSearchParams({ alt: 'media', supportsAllDrives: 'true' });
    if (useOAuth) headers.Authorization = `Bearer ${await tokens.getAccessToken()}`;
    else params.set('key', apiKey);
    const res = await gfetch(`${urls.driveApi}/files/${encodeURIComponent(fileId)}?${params}`, { headers, signal });
    if (!res.ok && res.status !== 416) throw await driveError(res, 'read the media file');
    return res;
  }

  return {
    getFolder,
    openMedia,
    usesOAuth: useOAuth,
    listChildren: (folderId) => list(folderId, useOAuth),
  };
}
