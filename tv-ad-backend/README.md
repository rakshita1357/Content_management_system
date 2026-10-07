# TV ad display: backend (Phase 1)

Scans a public Google Drive folder (one subfolder per ad), builds `ads.json` and the TV start page
`index.html`, and publishes both into the same Drive folder. It re-checks every 5 minutes and has
an admin page for uploading ads. Requires Node.js 22 or newer. No npm packages needed.

## Setup in short
1. Drive: share the folder as "Anyone with the link: Viewer". Copy its ID from the URL.
2. Google Cloud: enable the Google Drive API, then create an API key restricted to the Drive API.
3. `cp .env.example .env`, fill in `DRIVE_FOLDER_ID` and `DRIVE_API_KEY`, then run `npm run scan`.
4. Create an OAuth client (type: Desktop app). Set the consent screen to In production.
5. Put the client ID and secret in `.env`, run `npm run auth`, and paste the refresh token into `.env`.
6. Set `ADMIN_PASSWORD`, run `npm start`, and open http://localhost:8080/admin.

## Commands
| Command | What it does |
| --- | --- |
| `npm run scan` | Read-only check with the API key. Writes `data/ads.preview.json` and `data/index.preview.html`. |
| `npm run auth` | One-time Google sign-in that prints `GOOGLE_REFRESH_TOKEN`. |
| `npm start` | Starts the backend and the admin page, and syncs every `SYNC_INTERVAL_SEC`. |
| `npm test` | Unit and end-to-end tests against a fake Drive. No internet needed. |

## The TV page (the "browser part")
- Open `http://<backend-address>:8080/tv` on the TV (or any browser). No login needed.
- It shows the run-order table first, with a 10 second countdown, then the fullscreen player starts. Press Enter on "Start playing" to start sooner.
- Playback: ads in run order, images for `IMAGE_DURATION_SEC` (60), videos until they end, then back to the first ad.
- Keys: Esc / Back / the small X (bottom-right) return to the table; Left/Right skip to the previous/next ad.
- The green/red Wi-Fi icon (bottom-left) shows whether the TV can reach the backend.
- The page checks `/tv/ads.json` every sync interval and switches to a new revision at the next ad change.
- Media is streamed through `/api/ads/:id/content`, so no Google key reaches the browser. Only ads listed in `ads.json` are served.
- The `index.html` copy published to Drive is a snapshot for reference; the TV should open `/tv` from the backend.

## Who reads what
- The backend scan and sync run as the signed-in Google account (OAuth) when `GOOGLE_REFRESH_TOKEN` is set, so a private folder is scanned correctly.
- Without OAuth the scan falls back to the API key, which only sees folders shared as "Anyone with the link: Viewer". A private folder then looks empty (0 ads).
- The TV itself only has the API key, so the folder must still be shared as "Anyone with the link: Viewer" for playback. The admin page shows a red warning if it is not.
- `npm run scan` is key-only on purpose: it shows what the TV can see.

## Rules the scanner follows
- Each subfolder of the main folder is one ad. Files directly in the main folder are ignored.
- Supported formats: MP4, JPG, PNG. Everything else is listed under "not playing" with the reason.
- Play order is oldest upload first, across all ads.
- Images show for `IMAGE_DURATION_SEC`. Videos play to the end; their length shows once Drive has processed them.
- `ads.json` and `index.html` are rewritten only when the content changes (see `revision`).

## Layout
```
src/config.js                  settings from .env, supported formats
src/drive/publicReader.js      lists folders with the API key (same access as the TV)
src/drive/oauth.js             refresh token -> access token
src/drive/writer.js            creates folders, overwrites ads.json/index.html, streams uploads
src/manifest/buildManifest.js  Drive listing -> ads.json (pure function)
src/manifest/validate.js       checks ads.json before publishing
src/manifest/renderIndexHtml.js  ads.json -> TV start page (ES5, works on old webOS)
src/services/syncService.js    scan, compare revision, publish, 5-minute timer
src/services/uploadService.js  checks uploads and puts them in the right subfolder
src/app.js                     HTTP routes and login
public/admin.html              admin page
docs/ads.schema.json           ads.json format
```
