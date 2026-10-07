// Checks this installation before (or after) it goes into service. Run: npm run doctor
import { loadConfig } from '../src/config.js';
import { createPublicReader } from '../src/drive/publicReader.js';
import { createTokenProvider } from '../src/drive/oauth.js';
import { createStateStore } from '../src/lib/stateStore.js';
import { runDoctor } from '../src/lib/doctor.js';

let config;
try {
  config = loadConfig();
} catch (err) {
  console.log(`✗ Settings: ${err.message}`);
  process.exit(1);
}
const tokens = createTokenProvider(config);
const results = await runDoctor({ config, tokens, reader: createPublicReader(config, tokens), store: createStateStore(config.dataDir) });
const mark = { ok: '✓', warn: '!', fail: '✗' };
for (const r of results) {
  console.log(`${mark[r.level]} ${r.name}: ${r.detail}`);
  if (r.fix && r.level !== 'ok') console.log(`    → ${r.fix}`);
}
const failed = results.filter((r) => r.level === 'fail').length;
const warned = results.filter((r) => r.level === 'warn').length;
console.log(failed ? `\n${failed} problem${failed === 1 ? '' : 's'} to fix.` : warned ? `\nReady, with ${warned} thing${warned === 1 ? '' : 's'} to look at.` : '\nAll good.');
process.exit(failed ? 1 : 0);
