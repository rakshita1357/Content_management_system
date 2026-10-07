import { createHash } from 'node:crypto';
import { FOLDER_MIME, MEDIA_TYPES, PUBLISHED_FILES } from '../config.js';

export const SCHEMA_VERSION = 1;

const positive = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);

function toAd(file, folder, imageDurationSec) {
  const type = MEDIA_TYPES[file.mimeType];
  const meta = file.videoMediaMetadata || file.imageMediaMetadata || {};
  const durationMs = positive(file.videoMediaMetadata?.durationMillis);
  return {
    id: file.id,
    adName: folder.name,
    adFolderId: folder.id,
    fileName: file.name,
    mimeType: file.mimeType,
    type,
    // Images: fixed time on screen. Videos: real length if Drive has processed it, else null ("plays to the end").
    durationSec: type === 'image' ? imageDurationSec : durationMs ? Math.round(durationMs / 100) / 10 : null,
    sizeBytes: Number(file.size || 0),
    md5: file.md5Checksum || null,
    width: positive(meta.width),
    height: positive(meta.height),
    createdTime: file.createdTime,
    modifiedTime: file.modifiedTime,
    // The backend streams the file (no Google credentials ever reach the TV).
    src: `/api/ads/${file.id}/content`,
  };
}

// The revision changes only when something the TV cares about changes (not on every scan).
export function computeRevision(manifest) {
  const { generatedAt, revision, ...rest } = manifest;
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex').slice(0, 12);
}

/**
 * Pure function: Drive listings in, ads.json object out.
 * rootChildren: files directly in the main folder.
 * folderChildren: Map of subfolder ID -> files in that subfolder.
 */
export function buildManifest({ rootFolderId, rootChildren, folderChildren, imageDurationSec, syncIntervalSec, now = new Date() }) {
  const ads = [];
  const skipped = [];
  const reserved = new Set(Object.values(PUBLISHED_FILES));
  const folders = rootChildren.filter((f) => f.mimeType === FOLDER_MIME);

  for (const f of rootChildren) {
    if (f.mimeType !== FOLDER_MIME && !reserved.has(f.name)) {
      skipped.push({ fileName: f.name, adName: null, reason: 'Files in the main folder are ignored. Move it into an ad subfolder.' });
    }
  }

  for (const folder of folders) {
    for (const file of folderChildren.get(folder.id) || []) {
      if (file.mimeType === FOLDER_MIME) {
        skipped.push({ fileName: file.name, adName: folder.name, reason: 'Folders inside an ad folder are not scanned. Move its files up one level.' });
      } else if (!MEDIA_TYPES[file.mimeType]) {
        skipped.push({ fileName: file.name, adName: folder.name, reason: `Unsupported format (${file.mimeType}). Use MP4, JPG or PNG.` });
      } else {
        ads.push(toAd(file, folder, imageDurationSec));
      }
    }
  }

  // First come, first served: oldest upload plays first.
  ads.sort((a, b) => a.createdTime.localeCompare(b.createdTime)
    || a.adName.localeCompare(b.adName)
    || a.fileName.localeCompare(b.fileName));

  const known = ads.filter((a) => a.durationSec !== null);
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    revision: '',
    generatedAt: now.toISOString(),
    source: { folderId: rootFolderId },
    settings: { imageDurationSec, syncIntervalSec, order: 'createdTime-asc' },
    summary: {
      totalAds: ads.length,
      videos: ads.filter((a) => a.type === 'video').length,
      images: ads.filter((a) => a.type === 'image').length,
      totalBytes: ads.reduce((n, a) => n + a.sizeBytes, 0),
      loopSec: Math.round(known.reduce((n, a) => n + a.durationSec, 0)),
      unknownDurations: ads.length - known.length,
      adFolders: folders.map((f) => f.name).sort((a, b) => a.localeCompare(b)),
    },
    ads: ads.map((ad, i) => ({ order: i + 1, ...ad })),
    skipped,
  };
  manifest.revision = computeRevision(manifest);
  return manifest;
}
