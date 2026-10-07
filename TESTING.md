# What the system does and how to test each part

Work through the sections in order. Every row says **what to do** and **what you should see**. "Automated" means `npm test` /
`npm run test:browser` already check it, so a manual check is optional.

Tip for quick testing: put `IMAGE_DURATION_SEC=5` in `tv-ad-backend/.env` (the real default is 60) and restart.

---

## 0. Starting and stopping cleanly (Windows)
1. In `tv-ad-backend`: `npm run doctor`. Everything should be ✓. A `!` for the port only means a copy is already running.
2. **Only one copy can run.** If `npm start` says *"Port 8080 is already in use by another copy of this backend"*, an old window or service is still running:
   - close the old terminal window (Ctrl+C), **or**
   - `netstat -ano | findstr :8080` → the number in the last column is the PID → `taskkill /PID <pid> /F`, **or**
   - start a second one on another port: `set PORT=8081 && npm start`.
3. `npm start` prints three addresses: start page `/`, TV page `/tv/`, admin page `/admin` (login: user `admin`, your `ADMIN_PASSWORD`).
4. Stop with Ctrl+C.

---

## 1. Connecting a Drive folder (front page `/`)
| What to do | What you should see |
|---|---|
| Paste `https://drive.google.com/drive/folders/<ID>` and press **Submit** | You land on `/tv/` with the ad list. Links ending `?usp=sharing` and a bare ID also work. |
| Paste a file link, a non-Drive link, or a made-up folder ID | A red message with a "Fix:" hint. Nothing changes. |
| Put a file directly in the root, a `.pdf` in a subfolder, and an `.mp4`, `.jpg`, `.png` in subfolders | Only subfolder files of type MP4, JPG/JPEG, PNG are ads. The rest are listed under "Found in Drive but not playing". |
| Submit the **same** folder again | No dialog, nothing re-downloaded, just a sync. |
| Submit the **same** folder again while the backend has **no Drive/internet** | Goes straight to `/tv/` and plays the saved ads (no error). A **different** link in that state shows "Cannot reach Google Drive" and changes nothing. |
| Submit a **different** valid folder | Dialog "Change Drive folder?". **Cancel** = nothing changes. **Change & Remove** = switches. |
| Replace a working folder with an **empty** one | Refused ("no supported ads"), old ads kept. |

## 2. Syncing with Drive
| What to do | What you should see |
|---|---|
| Add a file in Drive, wait up to 5 minutes | It appears in the admin Run order. |
| Press **Sync now** (admin page, or on the TV page: at most once every 10 s) | An immediate rescan. |
| Add one ad, replace one, delete one | Admin status line: "Last change …: 1 added, 1 changed, 1 removed". |
| Turn off the backend computer's internet for a few minutes, then back on | Admin shows an error with a hint, retries after 30 s / 1 min / 2 min, recovers by itself. |
| Drive suddenly returning nothing | Automated (one empty answer is ignored, a second is believed; **Sync now** is trusted). |

## 3. Admin page (`/admin`)
| What to do | What you should see |
|---|---|
| Open it | Status line "N ads, revision … is live on the TV page", Drive folder name, Add an ad, Run order. |
| Upload an ad (name + MP4/JPG/PNG file) | Progress bar, then the ad appears; a new ad name creates a Drive subfolder. Wrong type or >500 MB is refused with a reason. |
| Use a folder you can only view | Ads play, uploads are switched off with a message. |
| **Screens** table (open `/tv/` on any device, wait about a minute) | The device appears: status (Playing …/Showing the ad list/Offline), "Up to date" or "Older list", saved ads + size, last seen. |
| `PUBLISH_TO_DRIVE=true` in `.env`, restart, sync | An `ads.json` copy appears in the Drive folder (optional; the TV never reads it). |

## 4. The TV page (`/tv/`)
| What to do | What you should see |
|---|---|
| Open `/tv/` | Folder, saved ads and size, Online, last sync, the ad table (with an **Offline** column) and buttons **Start playing**, **Sync now**, **Change Drive folder**. |
| Wait | After 10 s it starts (on an empty cache it waits up to 30 s more for the first ad to be saved). |
| Watch an image | Shown for `IMAGE_DURATION_SEC` (60 by default). |
| Watch a video | Plays to the end, then the next ad; after the last ad it loops. |
| Press **Start playing** | Fullscreen (browsers only allow this after a key press). |
| Let it auto-start with a video | A small speaker icon if the browser blocked sound. Press OK/any key: sound on. |
| Left/Right arrows; Esc or Backspace; Down then Enter on the X | Skip back/forward; return to the table; return to the table. Enter alone never exits. |
| Look at the bottom-left corner | Wi-Fi icon: green = reaches the backend, red = not. |

## 5. Offline play
Chrome tips: DevTools (F12) → **Network** tab → "Offline" simulates no internet. DevTools → **Application** → **IndexedDB** → `tvads` shows saved files. **Application → Storage → Clear site data** resets the cache.

| What to do | What you should see |
|---|---|
| Open `/tv/` and watch the **Offline** column | Waiting → a percentage → **Saved**. Header: "Saved for offline play: N of M ads". |
| Reload the page with internet | Nothing is downloaded again (Network tab: no `/content` requests). |
| Press Start, then set Network to **Offline** | Ads keep playing from saved files, icon turns red, it re-checks every 30 s. Back online → icon green, it syncs. |
| Stop `npm start` while a page is open, then reload that page | It starts from the saved list and plays (details screen says Offline). **A tab opened fresh while the backend is stopped cannot load**: the page itself comes from the backend. The Android app solves that (section 9). |
| Replace an ad in Drive while a TV plays | Old ads keep playing, only the changed ad downloads, the list switches between two ads. |
| Change the Drive folder | The TV keeps playing the old folder until the new one is fully saved, then switches and removes the old files. |
| Set a small `cacheMaxMb` in `web-core/config.js` | Ads that do not fit show **No space** and stream while online. |
| Failed / cut-off download | Automated (old playlist stays, retried every minute). |

## 6. Restarts and updates
| What to do | What you should see |
|---|---|
| Start playing, then reload the page | It goes straight back to playing (no countdown). |
| Press X, then reload | It stays on the list with the countdown. |
| Edit any line in `web-core/player.js` while a page is playing | Within one sync interval (5 min) it reloads between two ads and keeps playing. (The Android app does not: its page is built in.) |
| Stop and start `npm start` | The ad list is served again at once, even with the internet off; the admin page says "Showing the last saved ad list". |

## 7. Security
| What to do | What you should see |
|---|---|
| Start with `ADMIN_PASSWORD=change-me` | Log warning; only this computer can connect (TVs cannot). A real password (8+ characters) opens it to the network. `HOST=0.0.0.0` forces it. |
| Enter a wrong admin password 10 times | Then "Too many wrong passwords" for 10 minutes. TV pages are unaffected. |
| Open `/tv/ads.json` | No Google folder ID, only a short hash and the folder name. |
| `TLS_CERT_FILE` + `TLS_KEY_FILE` set | `https://` works (a real certificate is needed for TVs to trust it). |
| Cross-site request protection | Automated. |

## 8. Health, logs, doctor
| What to do | What you should see |
|---|---|
| Open `/api/health` (no login) | `ok, syncOk, ads, revision, lastSuccessAt, version, webVersion`. |
| Break the backend's internet for 3 syncs | `syncOk` becomes `false`. |
| `LOG_LEVEL=debug` and `LOG_FORMAT=json`, restart | One line per request; no passwords or query strings. |
| `npm run doctor` | ✓ / ! / ✗ per check with a fix for each problem. |
| `npm start` while a copy runs | A clear "Port … is already in use by another copy of this backend" message, exit, no crash text. |

## 9. Android TV app (`wrappers/androidtv`): never built or run yet
Build and install as in its README (Android Studio or `./gradlew assembleDebug`, then `adb install`). Then:
1. First start asks for the server address (e.g. `192.168.1.20:8080`, as printed by `npm start`), or has it built in.
2. The same pages as the browser; ads start **with sound**; the screen stays awake.
3. **Back** returns from the player to the list; Back twice within 2 s exits the app.
4. Stop the backend, close and reopen the app: it still opens and plays saved ads.
5. **Server address** button on the details screen (only inside the app); **Change Drive folder** asks for the admin login.
6. Start when the TV switches on: needs `adb shell appops set com.tvads.player SYSTEM_ALERT_WINDOW allow`; some TV makers block it.

## 10. Running it as a service
See `deploy/README.md` (systemd, Windows/NSSM, Docker, https, backups, updating). After installing, kill the service process and check it comes back in about 5 seconds. Untested; the Docker image has never been built.

## 11. Automated tests
```
cd tv-ad-backend
npm test               # 76 backend tests, no internet needed
npm run test:browser   # 21 real-browser tests (needs Playwright + ffmpeg, skipped otherwise)
```

## Not checked by anyone yet
A real Drive end to end, the Android app (build and device), any real TV, large videos (hundreds of MB) on TV storage, the Docker image and the Windows service steps.
