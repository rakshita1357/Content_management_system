import { driveError } from '../lib/errors.js';

// Reads the public folder with the API key only: exactly the access the TV will have.
const FIELDS = [
  'nextPageToken',
  'files(id,name,mimeType,size,md5Checksum,createdTime,modifiedTime,'
    + 'videoMediaMetadata(width,height,durationMillis),imageMediaMetadata(width,height))',
].join(',');

export function createPublicReader({ apiKey, urls }, fetchImpl = fetch) {
  async function listChildren(folderId) {
    const files = [];
    let pageToken;
    do {
      const params = new URLSearchParams({
        q: `'${folderId}' in parents and trashed = false`,
        fields: FIELDS,
        pageSize: '1000',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
        key: apiKey,
      });
      if (pageToken) params.set('pageToken', pageToken);
      const res = await fetchImpl(`${urls.driveApi}/files?${params}`);
      if (!res.ok) throw await driveError(res, 'list the folder');
      const body = await res.json();
      files.push(...(body.files || []));
      pageToken = body.nextPageToken;
    } while (pageToken);
    return files;
  }
  return { listChildren };
}
