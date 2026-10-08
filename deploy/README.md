# Running the TV ads backend for real

The backend is a small Node.js program that must stay up: TVs fetch the ad list and the files from it. This page covers
installing it as a service, using https, backups, updates and keeping an eye on it.

Before anything else, on the machine that will run it:

```
cd tv-ad-backend
npm run doctor
```
It checks Node.js, the TV page files, the data folder, the admin password, the Google login, the Drive folder and the port, and says what to
do about each problem. Run it again after every change.

## What must be set
| Setting (`.env`) | Why |
|---|---|
| `ADMIN_PASSWORD` | At least 8 characters, not a placeholder. **Without a real password the backend only accepts connections from its own computer**, so TVs cannot reach it (set `HOST=0.0.0.0` only if you accept an open admin page). |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` | Google login (`npm run auth`). Put the OAuth consent screen *In production*, otherwise the token expires after 7 days. |
| `LOG_LEVEL`, `LOG_FORMAT` | `info` is normal; `debug` also logs every request. `json` gives one JSON object per line for log tools. Logs never contain passwords, tokens or query strings. |

The backend protects itself: a wrong admin password 10 times in 10 minutes blocks that address for 10 minutes, requests that another website
starts are refused, and unexpected errors stop the program so the service manager can start it again.

## Linux (systemd)
```
sudo useradd --system --home /opt/tvads tvads
sudo mkdir -p /opt/tvads && sudo cp -r tv-ad-backend web-core /opt/tvads/
sudo cp tv-ad-backend/.env /opt/tvads/tv-ad-backend/.env     # your settings
sudo chown -R tvads:tvads /opt/tvads && sudo chmod 600 /opt/tvads/tv-ad-backend/.env
sudo cp deploy/tvads.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now tvads
journalctl -u tvads -f          # the log
```
Edit the node path in the unit if `which node` is not `/usr/bin/node`. The unit restarts the backend 5 seconds after any unexpected stop and
lets it write only to its own `data/` folder.

## Windows
Use [NSSM](https://nssm.cc/) (a free service wrapper) from an administrator PowerShell, with your own paths:
```
nssm install TVAds "C:\Program Files\nodejs\node.exe" "--env-file=.env" "src\server.js"
nssm set TVAds AppDirectory "C:\tvads\tv-ad-backend"
nssm set TVAds AppExit Default Restart
nssm set TVAds AppRestartDelay 5000
nssm set TVAds AppStdout "C:\tvads\logs\out.log"
nssm set TVAds AppStderr "C:\tvads\logs\err.log"
nssm set TVAds AppRotateFiles 1
nssm start TVAds
New-NetFirewallRule -DisplayName "TV ads backend" -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow -Profile Private
```
Keep `web-core\` next to `tv-ad-backend\`. The service starts when Windows starts, before anyone signs in.

## Render (hosted)
See **`RENDER.md`** (and `../render.yaml`): the backend on the internet with https, no router or firewall setup. The free plan sleeps and forgets `data/`; use a paid plan with a disk for real use.

## Docker
```
cd deploy
docker compose up -d --build
docker compose logs -f
```
Settings come from `tv-ad-backend/.env`; the saved state lives in the `tvads-data` volume. The container reports its health to Docker
(`/healthz`). (The Dockerfile and compose file were written and checked for syntax, but the image was not built in the environment where
this was written. Run `npm run doctor` inside it if something is off.)

## https
The backend speaks plain `http`, which is fine on a trusted local network. Beyond that, use https. Two ways:
1. **Reverse proxy (recommended).** `deploy/Caddyfile` is a working example: Caddy gets and renews a free certificate. Set `TRUST_PROXY=true` in `.env` so the login limit sees real client addresses, and keep the backend itself private with `HOST=127.0.0.1`.
2. **Directly:** set `TLS_CERT_FILE` and `TLS_KEY_FILE` to a certificate and key (PEM files). The backend then serves https and sends HSTS.
Enter the `https://` address on the TVs / in the Android app. A browser or TV that does not trust a self-signed certificate will refuse it, so use a real one.

## Backups
Back up the backend's **`data/`** folder and **`.env`** (it holds secrets: keep the copy private).
- `data/state.json`: which Drive folder is active.
- `data/manifest.json`: the last good ad list (rebuilt from Drive by the next sync if lost).
- `data/screens.json`: which screens reported in (nice to have).
Nothing else needs backing up: ad files stay in Drive, and each TV re-downloads its saved ads if its storage is cleared. A damaged
`state.json` is moved aside as `state.json.damaged-<time>` and the backend starts clean, so you can look at it.

## Updating and going back
```
git pull
cd tv-ad-backend && npm test && npm run doctor
# then restart: systemctl restart tvads  |  nssm restart TVAds  |  docker compose up -d --build
```
- **TVs in a browser** pick up a new TV page on their own: they reload between two ads and resume playing.
- **The Android app** has the page built in. Rebuild and reinstall the APK after `web-core/` changes (the screens table on the admin page shows which page version each TV runs).
- **Going back:** `git checkout <earlier tag or commit>`, restart. `data/` stays compatible.

## Watching it
- **Is the backend up and syncing?** `GET /api/health` needs no login and returns `ok`, `syncOk`, `ads`, `revision`, `lastSuccessAt`, `version`, `webVersion`. Point an uptime monitor at it and alert when it stops answering or when `syncOk` is `false` (three failed syncs in a row, usually Drive or the internet).
- **Are the TVs alive?** The admin page has a **Screens** table: every TV reports in each minute with what it plays, which list it has, and how full its offline storage is. "Not seen for…" means that TV's page is closed or cannot reach the server.
- **Why did something fail?** The admin page shows the last sync error with a suggested fix; the log has the details.

## Security checklist
- [ ] Real `ADMIN_PASSWORD`; `.env` readable only by the service account.
- [ ] https if the backend is reachable beyond your own network.
- [ ] Only the backend port is open, and only to the network the TVs are on.
- [ ] OAuth consent screen *In production*; refresh token not shared.
- [ ] `npm run doctor` shows no ✗.
