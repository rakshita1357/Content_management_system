// Central configuration. Everything comes from .env (see .env.example).
import { fileURLToPath } from 'node:url';

export const FOLDER_MIME = 'application/vnd.google-apps.folder';

// Supported ad formats (decided in Phase 0). Add 'video/webm' etc. here later if the TV supports it.
export const MEDIA_TYPES = {
  'video/mp4': 'video',
  'image/jpeg': 'image',
  'image/png': 'image',
};

// Files the backend writes into the main folder; the scanner ignores them.
export const PUBLISHED_FILES = { manifest: 'ads.json', page: 'index.html' };

const ID_PATTERN = /^[A-Za-z0-9_-]{10,}$/;

export function loadConfig(env = process.env) {
  const missing = ['DRIVE_FOLDER_ID', 'DRIVE_API_KEY'].filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(`Missing ${missing.join(' and ')} in .env. Copy .env.example to .env and fill them in.`);
  }
  if (!ID_PATTERN.test(env.DRIVE_FOLDER_ID)) {
    throw new Error('DRIVE_FOLDER_ID looks wrong. Use only the ID part of the folder URL, not the whole link.');
  }
  const num = (name, fallback, min) => {
    const value = env[name] === undefined || env[name] === '' ? fallback : Number(env[name]);
    if (!Number.isFinite(value) || value < min) throw new Error(`${name} must be a number of at least ${min}.`);
    return value;
  };
  return {
    port: num('PORT', 8080, 1),
    rootFolderId: env.DRIVE_FOLDER_ID,
    apiKey: env.DRIVE_API_KEY,
    oauth: {
      clientId: env.GOOGLE_CLIENT_ID || '',
      clientSecret: env.GOOGLE_CLIENT_SECRET || '',
      refreshToken: env.GOOGLE_REFRESH_TOKEN || '',
    },
    adminUser: env.ADMIN_USER || 'admin',
    adminPassword: env.ADMIN_PASSWORD || '',
    imageDurationSec: num('IMAGE_DURATION_SEC', 60, 1),
    syncIntervalSec: num('SYNC_INTERVAL_SEC', 300, 30),
    maxUploadMb: num('MAX_UPLOAD_MB', 500, 1),
    publishToDrive: env.PUBLISH_TO_DRIVE !== 'false',
    dataDir: env.DATA_DIR || fileURLToPath(new URL('../data/', import.meta.url)),
    // Overridable so tests can point at a fake Google server.
    urls: {
      driveApi: env.DRIVE_API_BASE || 'https://www.googleapis.com/drive/v3',
      driveUpload: env.DRIVE_UPLOAD_BASE || 'https://www.googleapis.com/upload/drive/v3',
      token: env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
    },
  };
}