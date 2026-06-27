# ytdown — Plan

A small app to download a YouTube video as **MP3** (audio) or **MP4** (video). You paste a URL, pick a format, click a button, and get the file. The downloading is always your **own `yt-dlp` command**, isolated in a swappable `download.sh`. The UI is **React + TypeScript** (Vite), reused across the local web app and the native app.

Built in **three phases**:

| Phase | What | How |
|---|---|---|
| **1** | **Local, browser + server** (current) | React UI in the browser → small TypeScript Node server runs `yt-dlp` |
| **2** | **macOS native app** (Tauri) | the **same React UI** wrapped in a real `.app` → a Rust backend runs `yt-dlp`; **no browser, no server** |
| **3** | **IONOS VPS** | the Phase-1 web app served at `https://<your-domain>` behind a password (CloudPanel) |

Phase 2 is the new middle step: instead of opening a browser against a local server, you get a double-clickable macOS app that does the same job natively.

> **Personal-use only.** Download content you own, that is public-domain/Creative-Commons, or that you have the right to save. A downloader exposed on the open internet *will* be abused — **Phase 3 keeps it behind authentication; do not run it open.**

**Single-user tool — just you.** No accounts, no database. Phase 3's one Basic-Auth password is the whole login. The app UI is in **English**. Docs: `PLAN.md` / `HOW-IT-WORKS.md` are the English source; styled English renderings are `PLAN.html` / `HOW-IT-WORKS.html`; Korean renderings live in `downloads/PLAN_KO.html` and `downloads/HOW-IT-WORKS_KO.html`.

---

## 1. Goal & scope

**Goal:** one screen → paste a YouTube URL → choose MP3 or MP4 → receive the file.

**In scope (v1):**
- Single video URL at a time (one job at a time — serialized).
- Two formats, using **your exact commands** (§5): MP4 ≤1440p merged, MP3 @ 64K.
- A **React + TypeScript** UI, reused by Phase 1 (browser) and Phase 2 (Tauri native).
- Phase 2 produces a real macOS `.app` with **no browser and no separate server**.

**Out of scope (v1):** playlists/batch, accounts, a database, re-encoding/trimming, concurrent jobs.

---

## 2. Architecture

```
Phase 1 (browser + server) and Phase 3 (VPS):
  Browser (React SPA) ──POST /api/download──▶ Node server (server.ts) ──spawn──▶ download.sh ─▶ yt-dlp/ffmpeg
       ▲ live log (streamed) ─────────────────────────┘                                           │
       └── GET /api/file/<id> ◀──────────────────────────────────────────────────────────────────┘

Phase 2 (Tauri native .app):
  React SPA (same code) ──invoke("download")──▶ Rust backend ──spawn──▶ download.sh ─▶ yt-dlp/ffmpeg
       ▲ live log (Tauri events) ──────────────────────┘                                  │
       └── saved straight to a chosen folder ◀──────────────────────────────────────────┘
```

- **Phase 1 / 3:** the browser talks to a local Node server over HTTP; the server runs `download.sh` and streams the log back.
- **Phase 2:** the **same React UI** runs inside a native window; instead of `fetch("/api/...")` it calls Tauri's `invoke()`, and a small **Rust** backend runs `download.sh` and streams the log via Tauri events. No HTTP server, no browser.
- Either way the browser/UI never talks to YouTube — only the backend (via your script) does.

The React frontend detects which host it's in (`window.__TAURI__`) and picks `invoke()` vs `fetch()` accordingly, so one UI codebase serves all three phases.

---

## 3. Prerequisites

| Tool | Why | Phases | Install (macOS) |
|---|---|---|---|
| **yt-dlp** | the downloader | all | `brew install yt-dlp` |
| **ffmpeg** | MP3 extract + MP4 merge | all | `brew install ffmpeg` |
| **Node.js** ≥ 18 | build the React UI (+ Phase 1/3 server) | all | `brew install node` |
| **Rust** + **Tauri CLI** | Phase 2 native backend/build | 2 | `brew install rust` (or rustup) + `npm i -D @tauri-apps/cli` |

Plus `npm install` once. (VPS install details for Phase 3 are in §10.)

---

## 4. File structure

```
~/Sites/ytdown/
├── index.html             # Vite entry
├── src/                   # React + TS UI — SHARED by Phase 1 and Phase 2
│   ├── main.tsx
│   ├── App.tsx            # the UI; chooses invoke() (Tauri) vs fetch() (browser)
│   ├── App.css
│   ├── types.ts
│   └── api.ts             # (Phase 2) the invoke/fetch adapter
├── server/
│   └── server.ts          # Phase 1 / 3 backend (TypeScript, tsx)
├── src-tauri/             # Phase 2 — Rust native backend + Tauri config (added in §9)
│   ├── src/main.rs        # the `download` command + log events
│   ├── tauri.conf.json
│   └── Cargo.toml
├── download.sh            # YOUR yt-dlp commands (§5) — the only file you customize
├── vite.config.ts · tsconfig*.json · package.json
├── dist/                  # Vite build (gitignored)
└── downloads/             # output files + Korean *_KO.html docs (gitignored)
```

---

## 5. The download script (`download.sh`) — your exact commands

The backend (Node server or Rust) calls `bash download.sh "<URL>" "<mp3|mp4>" "<OUTDIR>"`:

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

Unchanged across all phases — both backends treat it as a black box (3 args in, a file out, exit 0).

---

## 6. UI (`src/App.tsx`) — React + TypeScript, English, shared

One React component. State holds the URL, the `Format`, a `busy` flag, the streamed `log`, and a result `status`. On submit it asks the backend to download, reads the streamed log live, and surfaces the finished file. The **same component** runs in the browser (Phase 1/3) and inside the Tauri window (Phase 2) — only the transport differs (`fetch` vs `invoke`), hidden behind `src/api.ts`.

---

## 7. Phase-1/3 server (`server/server.ts`)

Plain `node:http`, bound to `127.0.0.1`. Routes: `POST /api/download` (validate → serialize with a `busy` flag → `spawn("bash", [download.sh, …])` → stream stdout as the live log → final `__FILE__`/`__ERROR__` sentinel), `GET /api/file/<id>` (stream the file as an attachment, path-traversal guarded), and `GET <else>` (serve the built SPA from `dist/`). See `HOW-IT-WORKS.md` for the full walkthrough.

---

## 8. Phase 1 — local browser app (current)

1. `brew install yt-dlp ffmpeg node` → `npm install`.
2. `chmod +x download.sh`; test it alone against a known URL → an `.mp3` appears.
3. `npm run dev` → `http://127.0.0.1:5173` → paste URL → MP3/MP4 → Download. → **verify:** file downloads, log streams (hot-reload works).
4. `npm run build && npm start` → the built app serves both formats (the prod path Phase 3 uses).

**Phase 1 done** = both formats download in the browser, dev *and* production build. *(This phase is already built.)*

---

## 9. Phase 2 — macOS native app (Tauri)  🆕

**Goal:** a double-clickable `ytdown.app` that does the same job with no browser and no separate server, reusing the React UI.

1. **Add Tauri** to the existing project: `npm i -D @tauri-apps/cli @tauri-apps/api`, then `npx tauri init` → creates `src-tauri/` (Rust). Point `tauri.conf.json` at the existing Vite dev server (dev) and `dist/` (build).
2. **Rust backend** (`src-tauri/src/main.rs`): a `#[tauri::command] download(url, format)` that **validates** the URL (same youtube-host allowlist), **serializes** (one job at a time), `Command::new("bash").args([script, url, format, outdir])`, and streams each stdout line to the frontend via `app.emit("download-log", line)`. Returns the produced filename (newest-file diff, same logic as the Node server).
3. **Frontend adapter** (`src/api.ts`): if `window.__TAURI__` exists → `invoke("download", …)` + `listen("download-log", …)`; else → the existing `fetch("/api/download")` streaming path. `App.tsx` calls the adapter, unchanged otherwise.
4. **Output folder:** the native app writes to a user-chosen folder (or `~/Downloads`) via Tauri's dialog/path APIs — no `/api/file` round-trip needed (the file is already local).
5. **Run / build:** `npx tauri dev` (native window with HMR) → **verify** both formats download. `npx tauri build` → `src-tauri/target/release/bundle/macos/ytdown.app` (+ `.dmg`). → **verify:** the `.app` launches and downloads both formats with `yt-dlp`/`ffmpeg` on `PATH`.

**Notes:** yt-dlp/ffmpeg are used from the system `PATH` (keep app small) or bundled as Tauri "sidecars" later if you want a self-contained `.app`. For personal use, code-signing/notarization is optional (Gatekeeper right-click-open works).

**Phase 2 done** = `ytdown.app` opens a native window and downloads MP3/MP4, no browser, no server.

---

## 10. Phase 3 — IONOS VPS (CloudPanel)

Serve the Phase-1 web app at `https://<your-domain>` behind HTTPS + one Basic-Auth password.

**Server facts:** IONOS VPS `<VPS_IP>`, Ubuntu 24.04, 2 vCore / 2 GB / 80 GB. (`<VPS_IP>` and other deploy values are kept in `.env` — gitignored; copy `.env.example`.)

1. **DNS** → subdomain `A` record → `<VPS_IP>`. **IONOS firewall:** allow 80 + 443 (+ 22).
2. **Install** `ffmpeg` (apt) + the official `yt-dlp` binary; clone the repo; `npm install && npm run build`.
3. **CloudPanel → Node site**; run via PM2 (`pm2 start npm --name ytdown -- start`); `proxy_pass` to `127.0.0.1:5173`.
4. **TLS:** CloudPanel Let's Encrypt. **🔒 Basic Auth:** add your single user/password (that one password *is* the login). **Smoke test** both formats over HTTPS.

(Full step list + the disk-cleanup note are unchanged from the prior plan; the app still binds `127.0.0.1` with nginx as the public face.)

---

## 11. Security

- **Phase 3 auth:** one Basic-Auth password at nginx; app binds `127.0.0.1` (only nginx is public).
- **Injection guard:** URL passed to the spawned process as an arg, never a shell string (true for both the Node and the Rust backends); host validated first.
- **Serialize:** one job at a time. **Non-root** app user on the VPS.

---

## 12. Operational caveats

- **⚠️ YouTube blocks datacenter IPs.** On the VPS (Phase 3), `yt-dlp` often hits *"Sign in to confirm you're not a bot."* The **native app (Phase 2)** and local Phase 1 run from your home IP, so they don't have this problem — that's a real advantage of Phase 2. VPS mitigation: `--cookies cookies.txt`.
- **Keep yt-dlp fresh:** `yt-dlp -U` (or `brew upgrade yt-dlp`).
- **Disk:** the VPS auto-cleanup matters; locally, files just accumulate in your chosen folder.

---

## 13. Possible later additions

- Bundle yt-dlp/ffmpeg as Tauri sidecars for a fully self-contained `.app`.
- Auto-cleanup / "delete after download" (local + VPS).
- Playlist support; a quality picker; cookies-file support for the VPS bot-check.

Each is an isolated add-on — finish Phase 2, then Phase 3 first.
