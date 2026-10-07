// Read-only check: scans the folder (as your Google account if OAuth is set up, otherwise with the API key)
// and writes a local ads.preview.json. Nothing is written to Drive. Run: npm run scan
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, FOLDER_MIME } from '../src/config.js';
import { createPublicReader } from '../src/drive/publicReader.js';
import { createTokenProvider } from '../src/drive/oauth.js';
import { buildManifest } from '../src/manifest/buildManifest.js';
import { validateManifest } from '../src/manifest/validate.js';

try {
  const config = loadConfig();
  const reader = createPublicReader(config, createTokenProvider(config));
  const rootChildren = await reader.listChildren(config.rootFolderId);
  const folderChildren = new Map();
  for (const f of rootChildren.filter((x) => x.mimeType === FOLDER_MIME)) {
    folderChildren.set(f.id, await reader.listChildren(f.id));
  }
  const manifest = buildManifest({ ...config, rootChildren, folderChildren });
  const errors = validateManifest(manifest);
  if (errors.length) throw new Error(`Manifest invalid: ${errors.join('; ')}`);

  await mkdir(config.dataDir, { recursive: true });
  const jsonPath = path.join(config.dataDir, 'ads.preview.json');
  await writeFile(jsonPath, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`Read OK. ${manifest.summary.adFolders.length} ad folders, ${manifest.summary.totalAds} playable files.`);
  for (const ad of manifest.ads) {
    console.log(`  ${String(ad.order).padStart(3)}. ${ad.adName} / ${ad.fileName} (${ad.type}, ${(ad.sizeBytes / 1048576).toFixed(1)} MB)`);
  }
  for (const s of manifest.skipped) console.log(`  skipped: ${s.adName ? `${s.adName}/` : ''}${s.fileName}: ${s.reason}`);
  console.log(`\nWrote ${jsonPath}`);
} catch (err) {
  console.error(`Scan failed: ${err.message}`);
  if (err.hint) console.error(`Fix: ${err.hint}`);
  process.exit(1);
}
