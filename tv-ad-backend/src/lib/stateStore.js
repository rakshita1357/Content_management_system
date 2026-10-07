import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

// Remembers what was last published so restarts don't re-upload unchanged files.
export function createStateStore(dataDir) {
  const file = path.join(dataDir, 'state.json');
  return {
    async load() {
      try {
        return JSON.parse(await readFile(file, 'utf8'));
      } catch {
        return {};
      }
    },
    async save(state) {
      await mkdir(dataDir, { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, JSON.stringify(state, null, 2));
      await rename(tmp, file);
    },
  };
}
