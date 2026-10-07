# TV ad display: backend (Phase 1)

Scans a Google Drive folder (one subfolder per ad), builds `ads.json`, and serves it and the TV page
to the TV at `/tv/`. It re-checks every 5 minutes and has an admin page for uploading ads. Requires Node.js 22 or newer. No npm packages needed.

## Setup in short
1. Drive: create a folder (or use one your Google account can open). You will paste its link in the admin page (step 5).
2. Google Cloud: enable the Google Drive API, create an OAuth client (type: Desktop app) and set the consent screen to In production.
3. `cp .env.example .env`, fill in `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. (`DRIVE_FOLDER_ID` is optional, see below.)
4. Run `npm run auth` and paste the refresh token into `.env` as `GOOGLE_REFRESH_TOKEN`.
5. Set `ADMIN_PASSWORD`, run `npm start`, open http://localhost:8080/ and paste the Drive folder link. The backend checks it and takes you to the TV page.
6. Open http://localhost:8080/tv on the TV or any browser.

The folder does **not** need to be shared publicly: the backend reads it as your Google account and
streams the media to the TV. `DRIVE_API_KEY` is only an optional fallback for a folder shared as
"Anyone with the link: Viewer" when OAuth is not set up.

## Commands
| Command | What it does |
| --- | --- |
| `npm run scan` | Read-only check of the folder. Writes `data/ads.preview.json`. |
| `npm run auth` | One-time Google sign-in that prints `GOOGLE_REFRESH_TOKEN`. |
| `npm start` | Starts the backend and the admin page, and syncs every `SYNC_INTERVAL_SEC`. |
| `npm test` | Unit and end-to-end tests against a fake Drive. No internet needed. |

## Choosing the Drive folder (the front page)
Open `http://<backend-address>:8080/`. The page is just a box and a **Submit** button:
1. Paste a Drive folder link (`https://drive.google.com/drive/folders/<ID>`, with or without `?usp=sharing`, or just the ID) and press Submit.
2. The backend extracts the folder ID, rejects file links, non-Drive links and folders it cannot open (with a reason), reads the folder as your Google account, builds `ads.json` and remembers the folder in `data/state.json`.
3. On success the browser goes straight to `/tv`: the run-order table, then the fullscreen player.
If the folder has no ads yet, or the link is wrong, the page stays and says why.

The page asks for the admin login first when `ADMIN_PASSWORD` is set. A folder chosen here wins over `DRIVE_FOLDER_ID` in `.env`, which is now optional. If your Google account can only view the folder, ads are scanned and played but uploads are switched off. Until a folder is chosen, `/tv` shows a waiting page.

`/admin` is the separate management page (upload, Sync now, view `ads.json`). Its "Change" link goes back to the front page.

## The TV page (`web-core/`)
The TV page is a set of plain static files in `../web-core/` (`index.html`, `app.css`, `player.js`, `cache.js`, `config.js`). The backend serves them at `http://<backend-address>:8080/tv/` with no login, and a packaged TV app (webOS, Android TV) can bundle the very same folder. Nothing in it is generated per ad list: the page loads `/tv/ads.json` when it opens.
- It shows the run-order table first, with a 10 second countdown, then the fullscreen player starts. Press Enter on "Start playing" to start sooner.
- Playback: ads in run order, images for `IMAGE_DURATION_SEC` (60), videos until they end, then back to the first ad.
- Keys: Esc / Back / the small X (bottom-right) return to the table; Left/Right skip to the previous/next ad.
- The green/red Wi-Fi icon (bottom-left) shows whether the TV can reach the backend.
- The page re-reads `/tv/ads.json` every sync interval and switches to a new revision at the next ad change.
- If the backend cannot be reached, or no folder is connected yet, the page says so and retries every 10 seconds.
- Media is streamed through `/api/ads/:id/content`, so no Google key reaches the browser. Only ads listed in `ads.json` are served.
- **Different origin:** `config.js` holds `apiBase`. Empty means "the server that served this page". A packaged app sets it to the backend address, for example `window.TV_CONFIG = { apiBase: 'http://192.168.1.20:8080' };`. The TV routes send `Access-Control-Allow-Origin: *` so this works.
- Keep `player.js`, `cache.js` and `config.js` plain ES5 (no arrow functions, `let`/`const`, template strings); a test enforces it for old webOS browsers.
- If you deploy only the `tv-ad-backend` folder, point `WEB_CORE_DIR` at a copy of `web-core/`.

## How the sync copes with problems
- **Timeouts and retries:** every call to Google gives up after 30 seconds (`GOOGLE_TIMEOUT_MS`) instead of hanging the sync. Network errors, HTTP 429 and 5xx are repeated up to 3 times with growing waits (`GOOGLE_RETRIES`, `GOOGLE_RETRY_BASE_MS`). Uploads and "create" calls are never repeated, so nothing is created twice. A network failure shows as "Cannot reach Google Drive" with a hint instead of "fetch failed".
- **Retry soon after a failure:** after a failed sync the next try is in 30 s, then 1 min, 2 min and so on, never later than the normal interval (`SYNC_INTERVAL_SEC`). One success resets it.
- **A strange empty answer is not trusted at once:** if Drive suddenly returns no ads while ads were known, the previous list stays for one more check and the admin page warns. If the next scan is also empty it is believed. "Sync now" is always trusted. This stops a Drive hiccup from making every TV delete its saved ads.
- **The last good list survives a restart:** `data/manifest.json` is written after every change (write to a temp file, then rename, so a power cut cannot leave half a file). If Drive or the internet is down when the backend starts, `/tv/ads.json` still serves that list and the admin page says so. A failed scan never replaces the list.
- **What changed:** each new revision is compared with the previous one by Drive file id and shown as "N added, N changed, N removed" in the admin page, status and log.
- **Health:** `GET /api/health` (no login) returns `ok`, `needsSetup`, `ads`, `revision`, `lastSuccessAt` and `syncOk`. `syncOk` turns false after three failed syncs in a row, which is a good thing to monitor. `GET /api/status` (admin) has the details: `failures`, `lastError`, `lastChange`, `fromDisk`.

## Offline play (`web-core/cache.js`)
The TV page saves every ad's file in the browser's IndexedDB and plays the saved copy, so ads keep running when the backend or the network goes away.
- **Saving:** after the ad list loads, files are downloaded one at a time in play order. The table's **Offline** column shows Saved, a percentage, Waiting, No space or Will retry, and the header shows "Saved for offline play: 12 of 14 ads (350 MB)".
- **No pointless downloads:** a saved file is reused while its checksum (or modified time) and size are unchanged. A downloaded file whose size does not match Drive is thrown away and retried after 60 seconds.
- **Changes:** when an ad is replaced in Drive it is downloaded again; when it is deleted, its saved file is removed. Ads that are still in the list are never deleted.
- **Space:** the TV may use up to 70% of the space the browser allows (`navigator.storage`). Set `cacheMaxMb` in `web-core/config.js` to use a fixed limit instead. Ads that do not fit show "No space" and are streamed from the backend while it is reachable.
- **Network drops:** the current and following ads play from the saved copies, the Wi-Fi icon turns red, and the page checks the backend every 30 seconds until it answers, then catches up with any changes.
- **Restart without the backend:** if the page opens but cannot read `/tv/ads.json`, it starts from the last ad list it saved and plays the saved files. (A packaged TV app, which holds the page itself, can do this even when the backend is completely down.)
- **Limits:** the page itself comes from the backend, so a plain browser tab on a TV that is switched on with the backend down cannot open it. Browsers also decide how long they keep stored data; the page asks them to keep it.
- If IndexedDB is blocked (some private modes), the page streams from the backend exactly as before and says "Offline saving is not available in this browser".

## Trying it on an Android TV
1. Put the TV and the computer running the backend on the same Wi-Fi/network.
2. Run `npm start`. The log prints a line like `Open this on the TV (same Wi-Fi/network): http://192.168.1.20:8080/tv/`. On Windows, allow Node.js through the firewall for private networks when asked.
3. On the computer, open `http://localhost:8080/`, paste the Drive folder link and press Submit.
4. In the TV's browser, open the address from step 2. (`localhost` only works on the computer itself.) Give the computer a fixed IP address, or the address can change after a restart.
5. Remote control: **OK** on "Start playing", then the ads run. **OK** during playback turns the sound on and goes fullscreen (browsers only allow sound after a key press). **Left/Right** skip. **Back** returns to the table. **Down** then **OK** presses the X. Pressing OK does not exit by accident.

A browser tab is for testing. For a TV that runs on its own, an installed Android TV app (a thin wrapper that loads `web-core/`, can start on boot, and keeps the screen awake) is the later step.

## Who reads what
- The backend scans and streams as the signed-in Google account (OAuth). The TV only talks to the backend.
- Without OAuth the backend falls back to `DRIVE_API_KEY`, which only sees folders shared as "Anyone with the link: Viewer". A private folder then looks empty (0 ads).
- By default the backend does not write anything to Drive except uploads. Set `PUBLISH_TO_DRIVE=true` to also keep a copy of `ads.json` in the folder (needs edit access; if that fails the admin page shows a warning and playback is unaffected). The TV does not read that copy. Older versions also saved an `index.html` there; the scanner ignores it and you can delete it.
- `/tv/ads.json` does not include the Drive folder ID.

## Rules the scanner follows
- Each subfolder of the main folder is one ad. Files directly in the main folder are ignored.
- Supported formats: MP4, JPG, PNG. Everything else is listed under "not playing" with the reason.
- Play order is oldest upload first, across all ads.
- Images show for `IMAGE_DURATION_SEC`. Videos play to the end; their length shows once Drive has processed them.
- The Drive copy of `ads.json` (if enabled) is rewritten only when the content changes (see `revision`).

## Layout
```
src/config.js                  settings from .env, supported formats
src/drive/publicReader.js      lists folders and streams media (OAuth, or API key fallback)
src/drive/oauth.js             refresh token -> access token
src/drive/writer.js            creates folders, overwrites the ads.json copy, streams uploads
src/manifest/buildManifest.js  Drive listing -> ads.json (pure function)
src/manifest/validate.js       checks ads.json before publishing
src/services/syncService.js    scan, compare revision, publish, 5-minute timer
src/services/uploadService.js  checks uploads and puts them in the right subfolder
src/app.js                     HTTP routes and login
public/start.html              front page: one box for the Drive folder link
public/admin.html              admin page (upload, Sync now)
../web-core/                   the TV page: index.html, app.css, player.js, cache.js, config.js (shared with TV wrappers)
docs/ads.schema.json           ads.json format
```
