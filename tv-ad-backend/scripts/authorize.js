// One-time setup: sign in with the Google account that owns the Drive folder and print a refresh token.
// Run on a computer with a web browser: npm run auth
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first (step 5).');
  process.exit(1);
}

const SCOPE = 'https://www.googleapis.com/auth/drive';
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash('sha256').update(verifier).digest());
const state = b64url(randomBytes(16));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const code = url.searchParams.get('code');
  if (!code && !url.searchParams.get('error')) { res.writeHead(404); return res.end(); }
  const finish = (status, message) => {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<p style="font:18px sans-serif;margin:3em">${message}</p>`);
    server.close();
  };
  if (url.searchParams.get('error')) {
    console.error(`Google returned: ${url.searchParams.get('error')}`);
    return finish(400, 'Sign-in was cancelled. Run npm run auth again.');
  }
  if (url.searchParams.get('state') !== state) return finish(400, 'Security check failed. Run npm run auth again.');

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
  });
  const body = await tokenRes.json();
  if (!tokenRes.ok || !body.refresh_token) {
    console.error('Token exchange failed:', body);
    return finish(500, 'Could not get a refresh token. See the terminal.');
  }
  console.log('\nSuccess. Add this line to .env, then restart the backend:\n');
  console.log(`GOOGLE_REFRESH_TOKEN=${body.refresh_token}\n`);
  finish(200, 'Done. Copy the refresh token from the terminal into .env. You can close this tab.');
});

let redirectUri;
server.listen(0, '127.0.0.1', () => {
  redirectUri = `http://127.0.0.1:${server.address().port}`;
  const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  auth.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  console.log('Open this link in a browser and sign in with the account that owns the Drive folder:\n');
  console.log(`${auth}\n`);
  console.log('Waiting for Google to redirect back...');
});
