import test from 'node:test';
import assert from 'node:assert/strict';
import { buildManifest } from '../src/manifest/buildManifest.js';
import { validateManifest } from '../src/manifest/validate.js';
import { ROOT_ID, sampleDrive } from './fixtures.js';

const build = (drive = sampleDrive(), now = new Date('2026-10-06T08:00:00Z')) => buildManifest({
  rootFolderId: ROOT_ID, rootChildren: drive.root, folderChildren: drive.children,
  imageDurationSec: 60, syncIntervalSec: 300, now,
});

test('orders ads oldest first across subfolders', () => {
  const m = build();
  assert.deepEqual(m.ads.map((a) => a.id), ['img1', 'vid1', 'vid2']);
  assert.deepEqual(m.ads.map((a) => a.order), [1, 2, 3]);
});

test('sets durations: images fixed, videos from Drive or null', () => {
  const [img, vid, unprocessed] = build().ads;
  assert.equal(img.durationSec, 60);
  assert.equal(vid.durationSec, 30.5);
  assert.equal(unprocessed.durationSec, null);
  assert.equal(img.src, '/api/ads/img1/content');
});

test('skips root files, unsupported types and nested folders, but not its own outputs', () => {
  const names = build().skipped.map((s) => s.fileName).sort();
  assert.deepEqual(names, ['brief.pdf', 'notes.txt', 'old']);
});

test('summary totals', () => {
  const s = build().summary;
  assert.equal(s.totalAds, 3);
  assert.equal(s.videos, 2);
  assert.equal(s.images, 1);
  assert.equal(s.loopSec, 91);
  assert.equal(s.unknownDurations, 1);
  assert.deepEqual(s.adFolders, ['Diwali offer', 'Monsoon sale']);
});

test('revision ignores generatedAt but changes with content', () => {
  const a = build(sampleDrive(), new Date('2026-10-06T08:00:00Z'));
  const b = build(sampleDrive(), new Date('2026-10-06T09:00:00Z'));
  assert.equal(a.revision, b.revision);
  const changed = sampleDrive();
  changed.children.get('fold_b')[0].md5Checksum = 'cc';
  assert.notEqual(build(changed).revision, a.revision);
});

test('generated manifest passes validation; broken one does not', () => {
  const m = build();
  assert.deepEqual(validateManifest(m), []);
  m.ads[0].order = 5;
  assert.ok(validateManifest(m).length > 0);
});
