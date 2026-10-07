import { AppError } from '../lib/errors.js';
import { createGoogleFetch } from '../lib/googleFetch.js';

// Exchanges the long-lived refresh token for short-lived access tokens, cached until near expiry.
export function createTokenProvider({ oauth, urls, google }, fetchImpl = fetch) {
  const gfetch = createGoogleFetch(google, fetchImpl);
  let cached = null;
  return {
    isConfigured() {
      return Boolean(oauth.clientId && oauth.clientSecret && oauth.refreshToken);
    },
    async getAccessToken() {
      if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
      const res = await gfetch(urls.token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: oauth.clientId,
          client_secret: oauth.clientSecret,
          refresh_token: oauth.refreshToken,
          grant_type: 'refresh_token',
        }),
      }, { repeatable: true }); // asking for a token again is harmless
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const hint = body.error === 'invalid_grant'
          ? 'The refresh token expired or was revoked. Run "npm run auth" again. If your OAuth consent screen is in Testing mode, tokens expire after 7 days; switch it to In production.'
          : 'Check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.';
        throw new AppError(502, `Google login failed: ${body.error || res.status} ${body.error_description || ''}`.trim(), hint);
      }
      cached = { token: body.access_token, expiresAt: Date.now() + (body.expires_in || 3600) * 1000 };
      return cached.token;
    },
  };
}
