import { AppError } from '../lib/errors.js';

const ID_PATTERN = /^[A-Za-z0-9_-]{10,}$/;

/**
 * Turns whatever the user pasted into a Drive folder ID.
 * Accepts: https://drive.google.com/drive/folders/<ID>, /drive/u/0/folders/<ID>?usp=sharing,
 * /folderview?id=<ID>, /open?id=<ID>, or the bare ID.
 */
export function parseFolderInput(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new AppError(400, 'Paste a Google Drive folder link.');
  if (ID_PATTERN.test(text)) return text;

  let url;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw new AppError(400, 'That does not look like a link.', 'Open the folder in Google Drive and copy the address from the browser bar.');
  }
  if (url.hostname !== 'drive.google.com') {
    throw new AppError(400, 'That is not a Google Drive link.', 'It should start with https://drive.google.com/drive/folders/');
  }
  if (/\/file\/d\//.test(url.pathname)) {
    throw new AppError(400, 'This link points to a single file, not a folder.', 'Open the folder that contains it and copy that address instead.');
  }
  const id = url.pathname.match(/\/folders\/([^/?#]+)/)?.[1] || url.searchParams.get('id');
  if (!id || !ID_PATTERN.test(id)) {
    throw new AppError(400, 'Could not find a folder in that link.', 'Open the folder itself in Google Drive (not "My Drive" or "Shared with me") and copy the address from the browser bar.');
  }
  return id;
}
