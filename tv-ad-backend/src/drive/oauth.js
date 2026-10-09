import { createSign } from 'node:crypto';
import { AppError } from '../lib/errors.js';
import { createGoogleFetch } from '../lib/googleFetch.js';

const SCOPE = 'https://www.googleapis.com/auth/drive';
const b64url = (input) => Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// A service account signs a short-lived token request with its private key. Unlike the refresh token it never expires:
// customers just share their Drive folder with the account's email address.
function signedAssertion(account, audience, nowSec) {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: account.email, scope: SCOPE, aud: audience, iat: nowSec, exp: nowSec + 3600 }));
  const signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(account.privateKey);
  return `${header}.${claims}.${b64url(signature)}`;
}

// Exchanges the long-lived credential (a service account key, or an OAuth refresh token) for short-lived access tokens,
// cached until near expiry.
export function createTokenProvider({ oauth, serviceAccount = null, urls, google }, fetchImpl = fetch) {
  const gfetch = createGoogleFetch(google, fetchImpl);
  let cached = null;
  return {
    kind: serviceAccount ? 'service-account' : 'oauth',
    serviceAccountEmail: serviceAccount ? serviceAccount.email : null,
    isConfigured() {
      return Boolean(serviceAccount || (oauth.clientId && oauth.clientSecret && oauth.refreshToken));
    },
    async getAccessToken() {
      if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
      const form = serviceAccount
        ? new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signedAssertion(serviceAccount, urls.token, Math.floor(Date.now() / 1000)) })
        : new URLSearchParams({ client_id: oauth.clientId, client_secret: oauth.clientSecret, refresh_token: oauth.refreshToken, grant_type: 'refresh_token' });
      const res = await gfetch(urls.token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form,
      }, { repeatable: true }); // asking for a token again is harmless
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const hint = serviceAccount
          ? 'Check GOOGLE_SERVICE_ACCOUNT_JSON: it must be the full key file of a service account, and the Google Drive API must be enabled for its project.'
          : body.error === 'invalid_grant'
          ? 'The refresh token expired or was revoked. Run "npm run auth" again. If your OAuth consent screen is in Testing mode, tokens expire after 7 days; switch it to In production.'
          : 'Check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.';
        throw new AppError(502, `Google login failed: ${body.error || res.status} ${body.error_description || ''}`.trim(), hint);
      }
      cached = { token: body.access_token, expiresAt: Date.now() + (body.expires_in || 3600) * 1000 };
      return cached.token;
    },
  };
}
