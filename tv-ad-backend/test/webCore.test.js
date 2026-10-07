import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { loadConfig } from '../src/config.js';

const dir = loadConfig({ DRIVE_API_KEY: 'k' }).webCoreDir;
const read = (name) => readFile(new URL(name, `file://${dir}`.replace(/\/?$/, '/')), 'utf8');

test('web-core scripts are plain ES5 (old TV browsers) and parse', async () => {
  for (const file of ['player.js', 'cache.js']) {
    const js = await read(file);
    assert.doesNotMatch(js, /=>|\blet\b|\bconst\b|`|padStart|\.\.\./, file);
    assert.doesNotThrow(() => new Function(js), file);
  }
  const cfg = await read('config.js');
  assert.doesNotMatch(cfg, /=>|\blet\b|\bconst\b|`/);
  assert.doesNotThrow(() => new Function('window', cfg));
});

test('every element id the player looks up exists in index.html', async () => {
  const js = await read('player.js');
  const html = await read('index.html');
  const wanted = new Set([...js.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]));
  assert.ok(wanted.size > 10);
  for (const id of wanted) assert.match(html, new RegExp(`id="${id}"`), `index.html is missing id="${id}"`);
});

test('index.html loads its files by relative path (so a packaged TV app can bundle the same folder)', async () => {
  const html = await read('index.html');
  assert.match(html, /href="app\.css"/);
  assert.match(html, /src="config\.js"/);
  assert.match(html, /src="player\.js"/);
  assert.match(html, /src="cache\.js"/);
  assert.ok(html.indexOf('cache.js') < html.indexOf('player.js'), 'cache.js loads first');
  assert.doesNotMatch(html, /(href|src)="\/(?!\/)/, 'no root-absolute paths');
});

test('the player offers the native hooks the Android TV app uses', async () => {
  const js = await read('player.js');
  assert.match(js, /window\.TV_NATIVE_BACK = /);
  assert.match(js, /TVNative\.changeServer/);
});

test('the player takes every URL from the configurable API base', async () => {
  const js = await read('player.js');
  assert.match(js, /apiBase/);
  assert.doesNotMatch(js, /(open\('GET', |\.src = )'\//, 'no hard-coded absolute backend paths');
  assert.match(js, /API \+ ad\.src/);
});

test('web-core file names are safe for the Android app, which only serves names made of letters, digits, . _ -', async () => {
  const names = await readdir(dir);
  assert.ok(names.includes('index.html'));
  for (const name of names) assert.match(name, /^[A-Za-z0-9._-]+$/, name);
  // the app serves these from its assets under web/; the page loads them by these names
  for (const name of ['index.html', 'app.css', 'player.js', 'cache.js', 'config.js']) assert.ok(names.includes(name), name);
});
