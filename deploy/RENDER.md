# Deploying on Render

Render runs the backend on the internet with https, so TVs anywhere can use it (no router, fixed IP or firewall to set up).
Nothing here has been run on Render by the author: follow it, and compare what you see with the "you should see" lines.

## Know this first
| | Free plan | Starter plan or higher (+ disk) |
|---|---|---|
| Sleeps when idle | **Yes** (after about 15 minutes without requests; the next request waits about a minute) | No |
| Keeps `data/` (chosen folder, saved ad list, screens) | **No**, wiped on every restart and deploy | Yes, with a disk |
| Good for | A trial or demo | Real use |

On the free plan an open TV page contacts the backend about every minute, which usually keeps it awake while TVs are on. It still sleeps overnight, and it forgets
everything in `data/` whenever it restarts. Set `DRIVE_FOLDER_ID` (below) so it reconnects to your folder by itself, and keep in mind that TVs keep playing their saved
ads whatever the backend does.

Other differences from running on your PC:
- **Uploads:** the admin page uploads through Render. Very large videos may time out; put big files into the Drive folder directly.
- **Bandwidth:** every TV downloads each ad through Render once. Check your plan's outbound bandwidth.
- **The Google token** (temporary login, expires every 7 days) lives in an environment variable. Renewing it means running `npm run auth` on a computer with a browser and pasting the new value into Render.

## Steps
1. **Put the code on GitHub `main`** (it already is, once the pull request containing this file is merged).
2. **Create the service.** In Render: *New +* > *Blueprint* > connect your GitHub account > choose the repository. Render reads `render.yaml`.
   - Starter plan with a 1 GB disk is the default there. For a free trial instead: *New +* > *Web Service* with these settings, and no disk:
     Runtime **Node**, Branch **main**, Root Directory **empty**, Build Command `echo "nothing to build"`, Start Command `node tv-ad-backend/src/server.js`, Health Check Path `/healthz`.
     In both cases leave **Auto-Deploy** off so a push never restarts a running screen by surprise.
3. **Environment variables** (Render dashboard > your service > *Environment*). Type them in; never paste them into chat or commit them.
   | Name | Value |
   |---|---|
   | `NODE_VERSION` | `22` |
   | `HOST` | `0.0.0.0` (without this Render sees no open port) |
   | `TRUST_PROXY` | `1` (Render's proxy sits in front, so the login lockout sees real client addresses) |
   | `ADMIN_PASSWORD` | a long private password: this site is on the public internet |
   | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` | the same three values as in your local `.env` |
   | `DRIVE_FOLDER_ID` | the folder id (the part after `/folders/` in the Drive link). Required on the free plan; harmless otherwise |
   | `DATA_DIR` | `/var/data` (only with a disk, see step 4) |
   | `LOG_FORMAT` | `json` (optional) |
   Do **not** set `PORT`: Render sets it.
4. **Disk (paid plans):** *Disks* > *Add disk*: name `tvads-data`, mount path `/var/data`, 1 GB. The blueprint does this for you.
5. **Deploy** (*Manual Deploy* > *Deploy latest commit*). In the *Logs* you should see: `TV ads backend ... listening on http://0.0.0.0:<port>`.
   - "No open ports detected" means `HOST=0.0.0.0` is missing or `ADMIN_PASSWORD` is not set (a weak or missing password limits the backend to its own machine).
6. **Check it.** Your address is `https://<service-name>.onrender.com`.
   - `/api/health` shows `{"ok":true,...}` (no login).
   - `/` and `/admin` ask for a login (user `admin`, your `ADMIN_PASSWORD`).
   - If you did not set `DRIVE_FOLDER_ID`, paste your Drive link on `/`.
   - The TV page `/tv/` shows your ads and the **Offline** column turns **Saved**.
7. **TVs:** open `https://<service-name>.onrender.com/tv/` in the TV's browser. In the Android app enter `https://<service-name>.onrender.com` as the server address.

## Routine
- **Updating:** merge to `main`, then *Manual Deploy*. Open browser TVs reload themselves between two ads.
- **Renewing the Google login (every 7 days while it is a temporary one):** on a computer with a browser run `npm run auth`, copy the new `GOOGLE_REFRESH_TOKEN` into Render's *Environment*, save (Render redeploys).
- **Watching it:** the admin page's Screens table and `/api/health` (`syncOk` false means Google trouble). Logs are in the Render dashboard.
- **Backups:** `data/` on the disk holds only the chosen folder, the saved ad list and the screens list. All of it is rebuilt from Drive. Keep your secrets (the environment variables) somewhere private.
