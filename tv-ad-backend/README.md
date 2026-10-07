# TV ad display: backend (Phase 1)

Scans a Google Drive folder (one subfolder per ad), builds `ads.json` and the TV page, and serves both
to the TV at `/tv`. It re-checks every 5 minutes and has an admin page for uploading ads. Requires Node.js 22 or newer. No npm packages needed.

## Setup in short
1. Drive: create a folder (or use one your Google account can open). You will paste its link in the admin page (step 5).
2. Google Cloud: enable the Google Drive API, create an OAuth client (type: Desktop app) and set the consent screen to In production.
3. `cp .env.example .env`, fill in `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. (`DRIVE_FOLDER_ID` is optional, see below.)
4. Run `npm run auth` and paste the refresh token into `.env` as `GOOGLE_REFRESH_TOKEN`.
5. Set `ADMIN_PASSWORD`, run `npm start`, open http://localhost:8080/admin and paste the Drive folder link. The backend checks it and shows the run order.
6. Open http://localhost:8080/tv on the TV or any browser.

The folder does **not** need to be shared publicly: the backend reads it as your Google account and
streams the media to the TV. `DRIVE_API_KEY` is only an optional fallback for a folder shared as
"Anyone with the link: Viewer" when OAuth is not set up.

## Commands
| Command | What it does |
| --- | --- |
| `npm run scan` | Read-only check of the folder. Writes `data/ads.preview.json` and `data/index.preview.html`. |
| `npm run auth` | One-time Google sign-in that prints `GOOGLE_REFRESH_TOKEN`. |
| `npm start` | Starts the backend and the admin page, and syncs every `SYNC_INTERVAL_SEC`. |
| `npm test` | Unit and end-to-end tests against a fake Drive. No internet needed. |

## Choosing the Drive folder
On first run the admin page shows a single box: paste a Drive folder link (`https://drive.google.com/drive/folders/<ID>`, with or without `?usp=sharing`, or just the ID) and press **Load ads**. The backend then:
1. extracts the folder ID and rejects file links, non-Drive links and folders it cannot open (with a reason);
2. reads the folder as your Google account, counts the ads, and warns about empty folders or files left in the main folder;
3. remembers the folder in `data/state.json` (it survives restarts) and syncs straight away.

Use **Change** in the admin page to switch folders later. A folder chosen in the admin page wins over `DRIVE_FOLDER_ID` in `.env`. If the signed-in account can only view the folder, ads are scanned and played but uploads are switched off.

Until a folder is chosen, `/tv` shows a waiting page that retries every 15 seconds.

## The TV page (the "browser part")
- Open `http://<backend-address>:8080/tv` on the TV (or any browser). No login needed.
- It shows the run-order table first, with a 10 second countdown, then the fullscreen player starts. Press Enter on "Start playing" to start sooner.
- Playback: ads in run order, images for `IMAGE_DURATION_SEC` (60), videos until they end, then back to the first ad.
- Keys: Esc / Back / the small X (bottom-right) return to the table; Left/Right skip to the previous/next ad.
- The green/red Wi-Fi icon (bottom-left) shows whether the TV can reach the backend.
- The page checks `/tv/ads.json` every sync interval and switches to a new revision at the next ad change.
- Media is streamed through `/api/ads/:id/content`, so no Google key reaches the browser. Only ads listed in `ads.json` are served.
- The TV should always open `/tv` from the backend. An `index.html` copy in Drive (optional, see below) is only a reference snapshot.

## Who reads what
- The backend scans and streams as the signed-in Google account (OAuth). The TV only talks to the backend.
- Without OAuth the backend falls back to `DRIVE_API_KEY`, which only sees folders shared as "Anyone with the link: Viewer". A private folder then looks empty (0 ads).
- By default the backend does not write anything to Drive except uploads. Set `PUBLISH_TO_DRIVE=true` to also keep copies of `ads.json` and `index.html` in the folder (needs edit access; if that fails the admin page shows a warning and playback is unaffected).
- `/tv/ads.json` and the TV page do not include the Drive folder ID.

## Rules the scanner follows
- Each subfolder of the main folder is one ad. Files directly in the main folder are ignored.
- Supported formats: MP4, JPG, PNG. Everything else is listed under "not playing" with the reason.
- Play order is oldest upload first, across all ads.
- Images show for `IMAGE_DURATION_SEC`. Videos play to the end; their length shows once Drive has processed them.
- `ads.json` and `index.html` are rewritten only when the content changes (see `revision`).

## Layout
```
src/config.js                  settings from .env, supported formats
src/drive/publicReader.js      lists folders and streams media (OAuth, or API key fallback)
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
