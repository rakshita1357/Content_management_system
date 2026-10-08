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
// ads.json is the optional Drive copy; index.html is ignored by the scanner because older versions published it.
export const PUBLISHED_FILES = { manifest: 'ads.json', page: 'index.html' };

const ID_PATTERN = /^[A-Za-z0-9_-]{10,}$/;

function oneOf(value, allowed, fallback, name) {
  if (value === undefined || value === '') return fallback;
  if (!allowed.includes(value)) throw new Error(`${name} must be one of: ${allowed.join(', ')}.`);
  return value;
}

function proxyHops(value) {
  if (value === undefined || value === '' || value === 'false' || value === '0') return 0;
  if (value === 'true') return 1;
  const n = Number(value);
  if (Number.isInteger(n) && n >= 1 && n <= 5) return n;
  throw new Error('TRUST_PROXY must be false, true, or the number of proxies in front of the backend (1 to 5).');
}

function tlsFrom(env) {
  const certFile = env.TLS_CERT_FILE || '';
  const keyFile = env.TLS_KEY_FILE || '';
  if (!certFile && !keyFile) return null;
  if (!certFile || !keyFile) throw new Error('Set both TLS_CERT_FILE and TLS_KEY_FILE to serve https, or neither.');
  return { certFile, keyFile };
}

export function loadConfig(env = process.env) {
  const hasOAuth = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN);
  if (!hasOAuth && !env.DRIVE_API_KEY) {
    throw new Error('Set up Google access in .env: either the OAuth values (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN; run "npm run auth") or, for a public folder only, DRIVE_API_KEY.');
  }
  if (env.DRIVE_FOLDER_ID && !ID_PATTERN.test(env.DRIVE_FOLDER_ID)) {
    throw new Error('DRIVE_FOLDER_ID looks wrong. Use only the ID part of the folder URL, not the whole link.');
  }
  const num = (name, fallback, min) => {
    const value = env[name] === undefined || env[name] === '' ? fallback : Number(env[name]);
    if (!Number.isFinite(value) || value < min) throw new Error(`${name} must be a number of at least ${min}.`);
    return value;
  };
  return {
    port: num('PORT', 8080, 1),
    // Optional: the folder can also be chosen in the admin page, which then takes priority.
    rootFolderId: env.DRIVE_FOLDER_ID || '',
    apiKey: env.DRIVE_API_KEY || '',
    oauth: {
      clientId: env.GOOGLE_CLIENT_ID || '',
      clientSecret: env.GOOGLE_CLIENT_SECRET || '',
      refreshToken: env.GOOGLE_REFRESH_TOKEN || '',
    },
    // Where to listen. Empty = chosen from the admin password (see lib/security.js).
    host: env.HOST || '',
    // How many proxies sit in front of the backend (0 = none). TRUST_PROXY=true means 1, a number means that many.
    trustProxy: proxyHops(env.TRUST_PROXY),
    tls: tlsFrom(env),
    logLevel: oneOf(env.LOG_LEVEL, ['debug', 'info', 'warn', 'error'], 'info', 'LOG_LEVEL'),
    logFormat: oneOf(env.LOG_FORMAT, ['text', 'json'], 'text', 'LOG_FORMAT'),
    adminUser: env.ADMIN_USER || 'admin',
    adminPassword: env.ADMIN_PASSWORD || '',
    imageDurationSec: num('IMAGE_DURATION_SEC', 20, 1),
    syncIntervalSec: num('SYNC_INTERVAL_SEC', 300, 30),
    maxUploadMb: num('MAX_UPLOAD_MB', 500, 1),
    // Off by default: the TV reads the backend, not Drive. Turn on to also keep ads.json/index.html copies in the folder.
    publishToDrive: env.PUBLISH_TO_DRIVE === 'true',
    webCoreDir: env.WEB_CORE_DIR || fileURLToPath(new URL('../../web-core/', import.meta.url)),
    dataDir: env.DATA_DIR || fileURLToPath(new URL('../data/', import.meta.url)),
    // How patient the backend is with Google. Advanced: rarely needs changing.
    google: {
      timeoutMs: num('GOOGLE_TIMEOUT_MS', 30000, 50),
      retries: num('GOOGLE_RETRIES', 3, 0),
      retryBaseMs: num('GOOGLE_RETRY_BASE_MS', 1000, 1),
    },
    // Overridable so tests can point at a fake Google server.
    urls: {
      driveApi: env.DRIVE_API_BASE || 'https://www.googleapis.com/drive/v3',
      driveUpload: env.DRIVE_UPLOAD_BASE || 'https://www.googleapis.com/upload/drive/v3',
      token: env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
    },
  };
}