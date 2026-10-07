import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export const appVersion = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

const WEB_FILES = ['index.html', 'app.css', 'player.js', 'cache.js', 'config.js'];

/**
 * A fingerprint of the TV page files. It changes whenever web-core/ is updated, so TVs that have the old page open can tell
 * (from /api/health) that they should reload. Cheap: files are only re-read when their size or time changes.
 */
export function createWebVersion(dir) {
  let lastKey = '';
  let value = '';
  return () => {
    let key = '';
    try {
      for (const f of WEB_FILES) { const s = statSync(path.join(dir, f)); key += `${f}:${s.size}:${s.mtimeMs};`; }
    } catch {
      return 'missing';
    }
    if (key !== lastKey) {
      const hash = createHash('sha256');
      for (const f of WEB_FILES) hash.update(readFileSync(path.join(dir, f)));
      value = hash.digest('hex').slice(0, 12);
      lastKey = key;
    }
    return value;
  };
}
