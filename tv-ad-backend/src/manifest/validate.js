import { MEDIA_TYPES } from '../config.js';
import { SCHEMA_VERSION } from './buildManifest.js';

// Safety net before publishing: never put a broken ads.json on the TV.
// Mirrors docs/ads.schema.json without needing a JSON Schema library.
export function validateManifest(m) {
  const errors = [];
  const need = (cond, msg) => { if (!cond) errors.push(msg); };
  need(m && typeof m === 'object', 'manifest must be an object');
  if (errors.length) return errors;
  need(m.schemaVersion === SCHEMA_VERSION, `schemaVersion must be ${SCHEMA_VERSION}`);
  need(/^[0-9a-f]{12}$/.test(m.revision), 'revision must be 12 hex characters');
  need(!Number.isNaN(Date.parse(m.generatedAt)), 'generatedAt must be an ISO date');
  need(Array.isArray(m.ads), 'ads must be an array');
  need(Array.isArray(m.skipped), 'skipped must be an array');
  const ids = new Set();
  (m.ads || []).forEach((ad, i) => {
    const at = `ads[${i}]`;
    need(ad.order === i + 1, `${at}.order must be ${i + 1}`);
    need(typeof ad.id === 'string' && ad.id.length > 0, `${at}.id missing`);
    need(!ids.has(ad.id), `${at}.id is duplicated`);
    ids.add(ad.id);
    need(MEDIA_TYPES[ad.mimeType] === ad.type, `${at}.type does not match mimeType`);
    need(ad.durationSec === null || ad.durationSec > 0, `${at}.durationSec must be positive or null`);
    need(ad.type !== 'image' || ad.durationSec > 0, `${at} is an image without a duration`);
    need(typeof ad.src === 'string' && ad.src.startsWith('https://'), `${at}.src must be an https URL`);
  });
  return errors;
}
