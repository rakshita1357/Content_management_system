import { driveError } from '../lib/errors.js';

// Lists Drive folders. By default it uses the API key only (exactly the access the TV has).
// When a token provider is passed and OAuth is configured, listChildren() authenticates as the
// signed-in Google account instead, so a PRIVATE folder is scanned correctly.
const FIELDS = [
  'nextPageToken',
  'files(id,name,mimeType,size,md5Checksum,createdTime,modifiedTime,'
    + 'videoMediaMetadata(width,height,durationMillis),imageMediaMetadata(width,height))',
].join(',');

export function createPublicReader({ apiKey, urls }, tokens = null, fetchImpl = fetch) {
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
      const res = await fetchImpl(`${urls.driveApi}/files?${params}`, init);
      if (!res.ok) throw await driveError(res, 'list the folder');
      const body = await res.json();
      files.push(...(body.files || []));
      pageToken = body.nextPageToken;
    } while (pageToken);
    return files;
  }
  // Opens a media file for streaming to the TV. Passes the Range header through so video can seek.
  async function openMedia(fileId, range, signal) {
    const headers = {};
    if (range) headers.Range = range;
    const params = new URLSearchParams({ alt: 'media', supportsAllDrives: 'true' });
    if (useOAuth) headers.Authorization = `Bearer ${await tokens.getAccessToken()}`;
    else params.set('key', apiKey);
    const res = await fetchImpl(`${urls.driveApi}/files/${encodeURIComponent(fileId)}?${params}`, { headers, signal });
    if (!res.ok && res.status !== 416) throw await driveError(res, 'read the media file');
    return res;
  }

  return {
    openMedia,
    usesOAuth: useOAuth,
    listChildren: (folderId) => list(folderId, useOAuth),
  };
}
