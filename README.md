# TV ad display

Plays ads (images and videos) from a Google Drive folder on a TV, and keeps playing them when the internet or the server goes away.

| Folder | What it is |
|---|---|
| `tv-ad-backend/` | The server: reads Drive, serves the TV page, admin page and ad files. **Run the commands below inside this folder.** |
| `web-core/` | The TV page itself (plain HTML/JS), served by the server and also bundled in the Android app. |
| `wrappers/androidtv/` | Android TV app that wraps `web-core/`. |
| `deploy/`, `render.yaml` | Service, Docker, https and Render deployment files. |

## What it does

Scans a Google Drive folder (one subfolder per ad), builds `ads.json`, and serves it and the TV page
to the TV at `/tv/`. It re-checks every 5 minutes and has an admin page for uploading ads. Requires Node.js 22 or newer. Run `npm install` once in `tv-ad-backend` (it only installs `pg`, used when a database is configured).

## Setup in short
Run all `npm` and `cp`/`copy` commands from the `tv-ad-backend` folder (`cd tv-ad-backend`).

1. Drive: create a folder (or use one your Google account can open). You will paste its link in the admin page (step 5).
2. Google Cloud: enable the Google Drive API, create an OAuth client (type: Desktop app) and set the consent screen to In production.
3. Copy `.env.example` to `.env` (`cp .env.example .env`, or `copy .env.example .env` on Windows), fill in `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. (`DRIVE_FOLDER_ID` is optional, see below.)
4. Run `npm run auth` and paste the refresh token into `.env` as `GOOGLE_REFRESH_TOKEN`.
5. Set `ADMIN_PASSWORD`, run `npm start`, open http://localhost:8080/ and paste the Drive folder link. The backend checks it and takes you to the TV page.
6. Open http://localhost:8080/tv on the TV or any browser.

The folder does **not** need to be shared publicly: the backend reads it as your Google account and
streams the media to the TV. `DRIVE_API_KEY` is only an optional fallback for a folder shared as
"Anyone with the link: Viewer" when OAuth is not set up.

### Better for several customers: a service account and a database
- **Service account instead of a personal login (never expires).** In Google Cloud create a *service account* for the project, add a JSON key, and put the whole key file in `GOOGLE_SERVICE_ACCOUNT_JSON` (or its base64). Each customer then shares their Drive folder with the account's email (Viewer is enough); the admin page shows that email. Uploading ads from the admin page needs an account that owns storage, so with a service account add ads in Drive directly.
- **Database instead of the disk (survives restarts).** Set `DATABASE_URL` to a Postgres connection string (a free Neon database works: copy it from the Neon dashboard, it ends in `?sslmode=require`). The chosen folder, the ad list and the screens list are then stored there. Without `DATABASE_URL` they are kept in `DATA_DIR` as before.
- On Render set the build command to `cd tv-ad-backend && npm ci --omit=dev`.
- The Screens table shows which Drive folder each TV is playing.

### A Drive folder per TV (pairing)
By default every TV plays the main folder (the one pasted on the front page). To give a TV its own folder:
1. Open the TV page on that TV. The facts line shows a **Pairing code** (6 characters, valid 15 minutes, a new one appears after that).
2. On the admin page, under **Screens → Pair a TV**, type the code, paste the Drive folder link (shared with the service account) and, if you like, a name. Press **Pair**.
3. Press **Sync now** on the TV (or wait for its next check): it switches to that folder's ads and keeps playing the old ones until the new ones are saved.
The Screens table shows each TV's folder; **Change folder** and **Use main folder** change it later. Each folder is scanned on its own timer and remembered across restarts.

## Running it for real
Run `npm run doctor` on the machine first: it checks the installation and says what to fix.
- The backend only listens on the local network when `ADMIN_PASSWORD` is real (8+ characters, not a placeholder). Otherwise it accepts connections from its own computer only (override with `HOST`).
- Wrong admin passwords are limited (10 in 10 minutes, then that address waits 10 minutes); requests started by another website are refused; unexpected errors stop the program so the service manager restarts it; a damaged `data/state.json` is kept aside and the backend starts clean.
- `GET /api/health` (no login) reports `ok`, `syncOk`, `ads`, `revision`, `lastSuccessAt`, `version` and `webVersion`.
- The admin page has a **Screens** table: each TV reports in every minute with its Drive folder, what it plays, which ad list it has, and how full its offline storage is.
- After a restart, an update or a power cut a TV goes straight back to playing (unless someone left the player with X or Back). A browser TV reloads itself between two ads when the backend serves a newer page.

## Commands
| Command | What it does |
| --- | --- |
| `npm run scan` | Read-only check of the folder. Writes `data/ads.preview.json`. |
| `npm run test:browser` | Real-browser tests of caching, offline play, restarts and updates (needs Playwright and ffmpeg). |
| `npm run auth` | One-time Google sign-in that prints `GOOGLE_REFRESH_TOKEN`. |
| `npm start` | Starts the backend and the admin page, and syncs every `SYNC_INTERVAL_SEC`. |
| `npm run doctor` | Checks Node.js, the TV page files, the data folder, the admin password, the Google login, the Drive folder and the port. |
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
The TV page is a set of plain static files in `web-core/` (`index.html`, `app.css`, `player.js`, `cache.js`, `config.js`). The backend serves them at `http://<backend-address>:8080/tv/` with no login, and a packaged TV app (webOS, Android TV) can bundle the very same folder. Nothing in it is generated per ad list: the page loads `/tv/ads.json` when it opens.
- It shows the run-order table first, with a 10 second countdown, then the fullscreen player starts. Press Enter on "Start playing" to start sooner.
- Playback: ads in run order, images for `IMAGE_DURATION_SEC` (20 seconds by default), videos until they end, then back to the first ad.
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
The TV page saves every ad's file in the browser's IndexedDB and plays the saved copy, so ads keep running when the backend or the network goes away. The saved files survive page refreshes, browser restarts and (as far as the browser allows) TV restarts.

**What is stored** (never any Google credentials): the files themselves, and the *committed list*: the ad list that is playing, its Drive folder (name and an opaque id), revision, when it was saved and when the backend last answered.

**Safe updates ("stage, verify, commit")**
1. A new list from the backend is only *staged*. The ads that are playing keep playing.
2. Missing or changed files are downloaded one at a time, in play order, and size-checked. They are stored under *ad id + checksum*, so an old version and its replacement exist side by side and nothing old is touched.
3. When everything is safely stored, one database transaction swaps in the new list and deletes the files nobody uses any more. The player switches between two ads, never in the middle of one.
A failed or cut-off download changes nothing. After 3 failed tries an ad is allowed to stream instead of blocking the update (and it keeps being retried every minute). An ad that does not fit in storage shows "No space", streams while online, and is saved later if space frees up.
The only exception is an empty cache: the first list plays at once (there is nothing else to play) and is committed when its files are saved. The countdown waits (up to 30 s longer) until the first ad is saved.

**No pointless downloads:** a saved file is reused while its checksum (or modified time) and size are unchanged, so a 5-minute sync downloads only what is new or changed.

**Changing the Drive folder**
- On the front page the link is *checked first* (does it exist, can the account open it, does it have ads). A broken, private, empty or unreachable link shows an error and changes nothing.
- If the link is valid but a different folder, a dialog asks "Change Drive folder?" (Cancel / Change & Remove). Cancel changes nothing. Entering the folder that is already active just runs a sync.
- A folder with no ads cannot replace a folder that has ads.
- TVs keep playing the old folder's ads until the new folder's ads are fully saved, then switch and delete the old files. The backend cannot delete files on a TV; this is how the TV does it.

**Space:** the TV may use up to 70% of the space the browser allows (`navigator.storage`), or the fixed limit `cacheMaxMb` in `web-core/config.js`. The details screen shows folder, ads saved and size, connection, last sync, and notes such as "Updating to a new version: 2 of 5 files saved".

**Network drops:** saved ads keep playing, the Wi-Fi icon turns red, and the page checks the backend every 30 seconds until it answers, then catches up. The TV's **Sync now** button runs a normal sync (at most once every 10 seconds, no login).

**Restart without the backend:** if the page opens but cannot read `/tv/ads.json`, it starts from the committed list and the saved files. A page that is *served by* a backend that is down cannot open in a plain browser tab; a packaged TV app that holds `web-core/` itself can (Phase 5).

If IndexedDB is blocked (some private modes), the page streams from the backend as before and says so.

**Tests:** `npm test` (backend, fake Drive) and `npm run test:browser` (a real headless Chromium against the real backend and a fake Drive: caching, offline play, restarts, folder change, failed downloads, incremental updates). The browser tests need Playwright (`PLAYWRIGHT_MODULE=/path/to/playwright`) and ffmpeg; they skip themselves without them.

## Android TV app
`wrappers/androidtv/` is a thin Android app around this same `web-core/` page: it opens even when the backend is down, plays with sound without a key press, keeps the screen awake and can start when the TV switches on. Build it with Android Studio, or `./gradlew assembleDebug` in that folder (add `-Ptvads.defaultServer=http://<backend address>:<port>` to build the server address in); install the APK with `adb install`.

## Trying it on an Android TV (browser)
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
tv-ad-backend/src/config.js                  settings from .env, supported formats
tv-ad-backend/src/drive/publicReader.js      lists folders and streams media (OAuth, or API key fallback)
tv-ad-backend/src/drive/oauth.js             refresh token -> access token
tv-ad-backend/src/drive/writer.js            creates folders, overwrites the ads.json copy, streams uploads
tv-ad-backend/src/manifest/buildManifest.js  Drive listing -> ads.json (pure function)
tv-ad-backend/src/manifest/validate.js       checks ads.json before publishing
tv-ad-backend/src/services/syncService.js    scan, compare revision, publish, 5-minute timer
tv-ad-backend/src/services/uploadService.js  checks uploads and puts them in the right subfolder
tv-ad-backend/src/app.js                     HTTP routes and login
tv-ad-backend/public/start.html              front page: one box for the Drive folder link
tv-ad-backend/public/admin.html              admin page (upload, Sync now)
tv-ad-backend/docs/ads.schema.json           ads.json format
web-core/                                    the TV page: index.html, app.css, player.js, cache.js, config.js (shared with the Android app)
wrappers/androidtv/                          Android TV app
```
