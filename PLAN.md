# ytdown — Plan

A small app to download a YouTube video as **MP3** (audio) or **MP4** (video). You paste a URL, pick a format, click a button, and get the file. The UI is **React + TypeScript** (built with Vite); the backend is a small **TypeScript Node server**. The actual downloading is your **own `yt-dlp` command**, isolated in a swappable `download.sh`.

Built in **two phases**: **(A)** build + test it locally, then **(B)** deploy it to your **IONOS VPS** behind HTTPS + a password.

> **Personal-use only — and this matters more once it's public.** Download content you own, that is public-domain/Creative-Commons, or that you have the right to save. A YouTube downloader exposed on the open internet *will* be found and abused (bandwidth, disk, and someone else's piracy on your IP). **Phase B keeps it behind authentication for exactly this reason — do not run it open.**

**This is a single-user tool — just you.** One password (HTTP Basic Auth) is the whole login: no sign-up, no accounts, no database. The app's UI is in **English**. (A Korean rendering of *this plan document* is provided as `PLAN.html`; `PLAN.md` is the English source. See also `HOW-IT-WORKS.md` for an implementation walkthrough.)

---

## 0. The two phases

| Phase | Where | Goal |
|---|---|---|
| **A** | your Mac (`127.0.0.1`) | get the download loop working: URL → MP3/MP4 file |
| **B** | IONOS VPS (`<VPS_IP>`, Ubuntu 24.04) | serve it at `https://<your-domain>`, password-protected, via CloudPanel |

Build A first; it's the same app, just bound locally. B is mostly ops (build, reverse proxy, TLS, auth, process manager).

---

## 1. Goal & scope

**Goal:** one screen → paste a YouTube URL → choose MP3 or MP4 → receive the file in the browser.

**In scope (v1):**
- Single video URL at a time (**one job at a time** — the VPS has 2 GB RAM, so jobs are serialized).
- Two formats, using **your exact commands** (§5): MP4 ≤1440p merged, MP3 @ 64K.
- A **React + TypeScript** single-page UI (English) + a small TypeScript Node server.
- **Single user (you only)** — gated by one password (HTTP Basic Auth); no accounts, no sign-up, no database.
- On the VPS: the file is produced server-side, streamed to your browser as a download, then auto-deleted.

**Out of scope (v1):** playlists/batch, accounts, a database, re-encoding/trimming, concurrent jobs.

---

## 2. Architecture

```
Browser (React SPA) ──POST /api/download {url,format}──▶ Node server (server.ts, 127.0.0.1)
   ▲                                                         │ spawn (args array, no shell)
   │  live log (streamed)                                    ▼
   │                                                    download.sh ──▶ yt-dlp + ffmpeg
   │                                                         │            → ./downloads/<title>.<ext>
   └──GET /api/file/<id> (attachment)◀───────────────────────┘  then delete after send / TTL

  ── Dev: Vite (5173, HMR) proxies /api → Node API (5174) ──
  ── Prod / Phase B ──
Internet ──https──▶ CloudPanel nginx (TLS + Basic Auth) ──proxy_pass──▶ Node server (127.0.0.1:5173, serves dist/ + /api)
```

- **Dev:** Vite serves the React app with hot-reload on 5173 and proxies `/api/*` to the Node server on 5174.
- **Prod:** Vite builds the app to `dist/`; the Node server serves `dist/` **and** `/api` on a single port. It **always binds `127.0.0.1`** — even on the VPS, where nginx (CloudPanel) is the public face (TLS + password).
- The browser never talks to YouTube; only the server does (via your script).

---

## 3. Prerequisites

**Local (Phase A) & VPS (Phase B)** both need:

| Tool | Why | macOS (local) | Ubuntu 24.04 (VPS) |
|---|---|---|---|
| **yt-dlp** | the downloader | `brew install yt-dlp` | official binary → `/usr/local/bin/yt-dlp` (see §9) |
| **ffmpeg** | MP3 extract + MP4 merge | `brew install ffmpeg` | `sudo apt install -y ffmpeg` |
| **Node.js** ≥ 18 | server + build | `brew install node` | via CloudPanel Node site / `apt` |

Plus **`npm install`** once per environment (React, Vite, TypeScript, tsx) — the app now has a build step.

---

## 4. File structure

```
~/Sites/ytdown/
├── index.html             # Vite entry (empty #root + module script)
├── src/
│   ├── main.tsx           # mounts <App/>
│   ├── App.tsx            # the UI: state + the streaming fetch
│   ├── App.css            # styles
│   └── types.ts           # Format = "mp3" | "mp4"
├── server/
│   └── server.ts          # API + serves dist/ (TypeScript, run via tsx)
├── download.sh            # YOUR yt-dlp commands (§5) — the only file you customize
├── vite.config.ts         # React plugin + dev proxy (/api → 5174)
├── tsconfig.json          # frontend TS
├── tsconfig.server.json   # backend TS (typecheck)
├── package.json           # deps + scripts (dev / build / start)
├── dist/                  # Vite build output (gitignored)
└── downloads/             # output files land here (gitignored)
```

---

## 5. The download script (`download.sh`) — your exact commands

The server calls `bash download.sh "<URL>" "<mp3|mp4>" "<OUTDIR>"`. Your two commands, dropped in verbatim (only `-o <template>` and `"$URL"` added so the app knows where the file goes):

```bash
#!/usr/bin/env bash
set -euo pipefail
URL="$1"; FORMAT="$2"; OUTDIR="$3"
TEMPLATE="$OUTDIR/%(title)s.%(ext)s"

if [ "$FORMAT" = "mp3" ]; then
  yt-dlp -f bestaudio --extract-audio --audio-format mp3 --audio-quality 64K \
         --no-mtime -o "$TEMPLATE" "$URL"
else
  yt-dlp -f "bestvideo[height<=1440][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1440]+bestaudio" \
         --merge-output-format mp4 --no-mtime -o "$TEMPLATE" "$URL"
fi
```

This is unchanged from the original — exactly your MP4 (≤1440p, mp4+m4a, merged) and MP3 (bestaudio → mp3 @ 64K) with `--no-mtime`. Change flags here anytime without touching the app.

---

## 6. UI (`src/App.tsx`) — React + TypeScript, English

A single React component, no router. State (`useState`) holds the URL, the chosen `Format`, a `busy` flag, the streamed `log`, and a result `status`. On submit it POSTs `{ url, format }`, then reads the streamed response body chunk-by-chunk (`getReader()` + `TextDecoder`) into the log, and parses the final `__FILE__` / `__ERROR__` sentinel line to show the result and auto-start the download. English UI: a URL input ("Paste a YouTube link"), MP3/MP4 radios (default MP4), a Download button ("Downloading…" while busy), a live `<pre>` log. (See `HOW-IT-WORKS.md` §3 for the full walkthrough.)

---

## 7. Server (`server/server.ts`) responsibilities

1. `GET <non-/api>` → `serveFrontend`: serve the built SPA from `dist/` (SPA fallback to `index.html`; path-traversal guarded). In dev this is rarely hit (Vite serves the UI).
2. `POST /api/download` `{ url, format }`:
   - **Validate**: `url` must be `https://` with host `youtube.com`/`youtu.be`; `format` ∈ {`mp3`,`mp4`}. Else `400`.
   - **Serialize**: if a job is already running, reject with `429` (2 GB RAM → one job at a time).
   - `spawn("bash", [SCRIPT, url, format, outdir])` — **args array, never a shell string** (injection guard).
   - Stream stdout/stderr to the browser for the live log; on exit `0`, end with the `__FILE__ <name>` sentinel.
3. `GET /api/file/<id>` → stream the produced file with `Content-Disposition: attachment` (UTF-8 filename), then (on the VPS) delete it / let the TTL sweep get it.
4. **Always bind `127.0.0.1`** (both phases).

---

## 8. Phase A — build & test locally

1. `brew install yt-dlp ffmpeg node` → `yt-dlp --version`, `ffmpeg -version`. → **verify:** versions print.
2. `npm install` (React, Vite, TypeScript, tsx). → **verify:** `node_modules/` appears, no errors.
3. `chmod +x download.sh` → test it alone: `mkdir -p downloads && ./download.sh "https://youtu.be/XXXX" mp3 "$PWD/downloads"`. → **verify:** an `.mp3` appears.
4. `npm run dev` → open `http://127.0.0.1:5173` → paste a URL → MP3 → Download. → **verify:** file downloads, log streams live (hot-reload works on edits).
5. Repeat with MP4. → **verify:** a merged ≤1440p `.mp4` plays.
6. `npm run build && npm start` → `http://127.0.0.1:5173`. → **verify:** the **built** app serves and both formats still work (this is the prod path the VPS uses).

**Phase A done** = both formats download through the browser, in dev *and* from the production build.

---

## 9. Phase B — deploy to the IONOS VPS (CloudPanel)

**Server facts (from your console):** IONOS VPS `<VPS_IP>`, Ubuntu 24.04, 2 vCore / 2 GB RAM / 80 GB NVMe, an IONOS firewall policy in front. (`<VPS_IP>` and other deploy values are kept in `.env` — gitignored; copy `.env.example` to `.env` and fill them in.)

**Steps:**

1. **DNS:** point a subdomain (e.g. `ytdown.yourdomain.com`) `A` record → `<VPS_IP>`.
2. **IONOS firewall:** allow inbound **80 + 443** (and 22 for SSH). CloudPanel itself listens on 8443.
3. **Install runtimes** (SSH as a non-root sudo user — don't run the app as root):
   ```bash
   sudo apt update && sudo apt install -y ffmpeg
   sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
   sudo chmod a+rx /usr/local/bin/yt-dlp
   yt-dlp --version && ffmpeg -version
   ```
   (Use the official `yt-dlp` binary, not apt's. Update later with `sudo yt-dlp -U`.)
4. **CloudPanel → Add Site → Node.js** (or a **Reverse Proxy** site): set the domain; CloudPanel creates the nginx vhost + app user + home dir.
5. **Deploy the code** into the site's home dir (`git clone` or `scp`). Then **`npm install` and `npm run build`** on the server (this produces `dist/`). `chmod +x download.sh`, `mkdir -p downloads`.
6. **Run it as a service** so it survives reboots/crashes — PM2 is simplest:
   ```bash
   sudo npm i -g pm2
   pm2 start npm --name ytdown -- start    # runs `npm start` → tsx server/server.ts on 127.0.0.1:5173
   pm2 save && pm2 startup                  # restart on boot
   ```
7. **Reverse proxy:** in CloudPanel's vhost, `proxy_pass` to `http://127.0.0.1:5173` (the Node site type wires this for you).
8. **TLS:** CloudPanel → site → **SSL/TLS → Let's Encrypt** → issue + force HTTPS. → **verify:** the domain loads with a valid cert.
9. **🔒 Lock it down (do NOT skip):** CloudPanel → site → **Basic Auth** → add your single username + password. **One-person tool, so that one password *is* the entire login** — no accounts, no DB. (Optional extra: an nginx IP allowlist to your own IP.)
10. **Smoke test:** open the URL, enter the Basic-Auth creds, download an MP3 and an MP4. → **verify:** both work over HTTPS; `pm2 logs ytdown` is clean.

**Phase B done** = `https://ytdown.yourdomain.com`, password-prompt, both formats download.

---

## 10. Security (public hosting — non-negotiable)

- **Auth in front:** one Basic-Auth password at nginx (step 9) — single-user, so that's the whole login. Never expose it open.
- **App binds `127.0.0.1`:** only nginx is public; the Node port is unreachable from the internet.
- **Injection guard:** URL passed to `spawn` as an arg, never concatenated into a shell string; host validated before spawning.
- **Rate-limit + serialize:** one job at a time (§7); optionally an nginx `limit_req` on `/api/download`.
- **Run as a non-root app user** (CloudPanel site user), not `root`.
- **Disk hygiene:** the cleanup sweep + per-download deletion keep `downloads/` from filling the 80 GB.

---

## 11. Operational caveats (read these — they're what actually bite)

- **⚠️ YouTube blocks datacenter IPs.** Serving `yt-dlp` from a VPS IP often triggers *"Sign in to confirm you're not a bot"* and fails, even when the same command works from your Mac. Mitigations: pass `--cookies /path/cookies.txt` (export a logged-in YouTube `cookies.txt` and keep it on the server), throttle, and accept it may be intermittently flaky. Budget for the VPS version being less reliable than local.
- **2 GB RAM:** fine for one serialized job; **don't allow concurrent jobs** (§7 serializes).
- **80 GB disk:** the auto-cleanup matters; without it, leftover files accumulate.
- **Keep yt-dlp fresh:** `sudo yt-dlp -U` (or a weekly cron).
- **Updates/restart:** `git pull && npm install && npm run build && pm2 restart ytdown`.

---

## 12. Possible later additions (only if needed)

- Cookies-file upload in the UI (to dodge the bot-check above).
- Playlist support; a quality picker (1080p/720p/1440p) surfaced in the UI.
- Embed thumbnail + metadata in the MP3 (`--embed-thumbnail --embed-metadata`).
- A small job history / "recent downloads" list.

Each is an isolated add-on — get Phase A, then Phase B working end-to-end first.
