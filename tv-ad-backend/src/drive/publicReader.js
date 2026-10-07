import { driveError } from '../lib/errors.js';

// Lists Drive folders. By default it uses the API key only (exactly the access the TV has).
// When a token provider is passed and OAuth is configured, listChildren() authenticates as the
// signed-in Google account instead, so a PRIVATE folder is scanned correctly. listChildrenPublic()
// always uses the API key, to check what the TV can really see.
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
  return {
    usesOAuth: useOAuth,
    listChildren: (folderId) => list(folderId, useOAuth),
    listChildrenPublic: (folderId) => list(folderId, false),
  };
}
