import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

// Writes a file so a crash or power cut can never leave half a file: write to a temp name, then rename.
async function writeAtomic(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, file);
}

// Remembers what the backend needs after a restart: which folder, what was last published, and the
// last good ad list (so TVs can still load ads if Drive or the internet is down when the backend starts).
export function createStateStore(dataDir, log = null) {
  const stateFile = path.join(dataDir, 'state.json');
  const manifestFile = path.join(dataDir, 'manifest.json');
  const screensFile = path.join(dataDir, 'screens.json');
  const readJson = async (file) => {
    let raw;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      return null;   // not there yet
    }
    try {
      return JSON.parse(raw);
    } catch {
      // Damaged (for example a disk problem): keep the evidence, start clean, and say so.
      const kept = `${file}.damaged-${Date.now()}`;
      await rename(file, kept).catch(() => {});
      if (log) log.warn(`${path.basename(file)} could not be read and was moved to ${path.basename(kept)}; starting without it.`);
      return null;
    }
  };
  return {
    kind: 'files',
    init: async () => {},
    async load() {
      return (await readJson(stateFile)) || {};
    },
    async save(state) {
      await writeAtomic(stateFile, JSON.stringify(state, null, 2));
    },
    loadManifest: () => readJson(manifestFile),
    async saveManifest(manifest) {
      if (!manifest) return rm(manifestFile, { force: true });
      return writeAtomic(manifestFile, JSON.stringify(manifest));
    },
    loadScreens: async () => (await readJson(screensFile)) || [],
    saveScreens: (rows) => writeAtomic(screensFile, JSON.stringify(rows)),
    close: async () => {},
  };
}
