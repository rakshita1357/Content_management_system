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
export function createStateStore(dataDir) {
  const stateFile = path.join(dataDir, 'state.json');
  const manifestFile = path.join(dataDir, 'manifest.json');
  const readJson = async (file) => {
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch {
      return null;
    }
  };
  return {
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
  };
}
