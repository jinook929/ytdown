# ytdown — Plan

A small **personal** app to download a YouTube video as **MP3** (audio) or **MP4** (video). You paste a URL, pick a format, click a button, and get the file. The downloading is always your own `yt-dlp` command, isolated in a swappable `download.sh`. The UI is **React + TypeScript** (Vite), reused by both forms of the app.

Built in **two phases**:

| Phase | What | How | Status |
|---|---|---|---|
| **1** | **Local web app** | React UI in the browser → small TypeScript Node server runs `yt-dlp` | ✅ built |
| **2** | **macOS native app** (Tauri) | the **same React UI** wrapped in a real `.app` → a Rust backend runs `yt-dlp`; **no browser, no server** | ✅ built |

> **Out of scope: VPS / public hosting.** An earlier draft had a third phase that deployed the web app to a VPS behind a password. We **decided against it**: this is a single-user personal tool, and running `yt-dlp` from a datacenter IP reliably trips YouTube's *"Sign in to confirm you're not a bot"* check. The local web app (Phase 1) and the native app (Phase 2) — both running from a home IP — cover the need without the hosting overhead.

> **Personal-use only.** Download content you own, that is public-domain/Creative-Commons, or that you have the right to save, and respect YouTube's Terms of Service.

**Single-user — just you.** No accounts, no server-side auth, no database. The app UI is in **English**. Docs: `PLAN.md` / `HOW-IT-WORKS.md` are the English source; styled English renderings are `PLAN.html` / `HOW-IT-WORKS.html`; Korean renderings live in `downloads/PLAN_KO.html` and `downloads/HOW-IT-WORKS_KO.html`.

---

## 1. Goal & scope

**Goal:** one screen → paste a YouTube URL → choose MP3 or MP4 → receive the file.

**In scope:**
- Single video URL at a time (one job — serialized).
- Two formats, your exact commands (§5): MP4 ≤1440p merged, MP3 @ 64K.
- A React + TypeScript UI, reused by Phase 1 (browser) and Phase 2 (native).
- Phase 2 produces a real macOS `.app` with no browser and no separate server.

**Out of scope:** VPS/public hosting (see above), playlists/batch, accounts, a database, re-encoding/trimming, concurrent jobs.

---

## 2. Architecture

```
Phase 1 (local web app):
  Browser (React SPA) ──POST /api/download──▶ Node server (server.ts, 127.0.0.1) ──spawn──▶ download.sh ─▶ yt-dlp/ffmpeg
       ▲ live log (streamed) ─────────────────────────┘                                                     │
       └── GET /api/file/<id> ◀────────────────────────────────────────────────────────────────────────────┘

Phase 2 (macOS native .app):
  React SPA (same code) ──invoke("download")──▶ Rust backend ──spawn──▶ download.sh ─▶ yt-dlp/ffmpeg
       ▲ live log (Tauri events) ──────────────────────┘                                  │
       └── saved to ~/Downloads ◀────────────────────────────────────────────────────────┘
```

- **Phase 1:** the browser talks to a local Node server over HTTP; the server runs `download.sh` and streams the log back.
- **Phase 2:** the **same React UI** runs inside a native window; instead of `fetch("/api/...")` it calls Tauri's `invoke()`, and a small **Rust** backend runs `download.sh` and streams the log via Tauri events. No HTTP server, no browser.
- Either way the UI never talks to YouTube — only the backend (via your script) does. The React frontend detects its host (`window.__TAURI_INTERNALS__`) and picks `invoke()` vs `fetch()`, so one UI codebase serves both phases.

---

## 3. Prerequisites

| Tool | Why | macOS |
|---|---|---|
| **yt-dlp** | the downloader | `brew install yt-dlp` |
| **ffmpeg** | MP3 extract + MP4 merge | `brew install ffmpeg` |
| **Node.js** ≥ 18 | build the React UI (+ Phase 1 server) | `brew install node` |
| **Rust** | Phase 2 native build only | `brew install rust` |

Plus `npm install` once.

---

## 4. File structure

```
~/Sites/ytdown/
├── README.md              # quick start
├── index.html             # Vite entry
├── src/                   # React + TS UI — SHARED by Phase 1 and Phase 2
│   ├── main.tsx
│   ├── App.tsx            # the UI; chooses invoke() (Tauri) vs fetch() (browser)
│   ├── App.css · types.ts
│   └── api.ts             # the invoke/fetch adapter
├── server/server.ts       # Phase 1 backend (TypeScript, tsx)
├── src-tauri/             # Phase 2 — Rust native backend + Tauri config
│   ├── src/lib.rs         # the `download` command + log events
│   ├── tauri.conf.json · Cargo.toml
├── download.sh            # YOUR yt-dlp commands (§5) — the only file you customize
├── vite.config.ts · tsconfig*.json · package.json
├── dist/                  # Vite build output (gitignored)
└── downloads/             # Phase-1 output files + Korean *_KO.html docs (gitignored)
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

The same for both phases — both backends treat it as a black box (3 args in, a file out, exit 0).

---

## 6. UI (`src/App.tsx`) — React + TypeScript, English, shared

One React component. State holds the URL, the `Format`, a `busy` flag, the streamed `log`, and a result `status`. The **same component** runs in the browser (Phase 1) and inside the Tauri window (Phase 2) — only the transport differs (`fetch` vs `invoke`), hidden behind `src/api.ts`. (See `HOW-IT-WORKS.md` for the full walkthrough.)

---

## 7. Phase-1 server (`server/server.ts`)

Plain `node:http`, bound to `127.0.0.1`. Routes: `POST /api/download` (validate → serialize with a `busy` flag → `spawn("bash", [download.sh, …])` → stream stdout as the live log → final `__FILE__`/`__ERROR__` sentinel), `GET /api/file/<id>` (stream the file as an attachment, path-traversal guarded), and `GET <else>` (serve the built SPA from `dist/`).

---

## 8. Phase 1 — local web app

1. `brew install yt-dlp ffmpeg node` → `npm install`.
2. `chmod +x download.sh`; test it alone → an `.mp3` appears.
3. `npm run dev` → `http://127.0.0.1:5173` → paste URL → MP3/MP4 → Download. → **verify:** file downloads, log streams (hot-reload works).
4. `npm run build && npm start` → the built app serves both formats. → ✅ **built.**

---

## 9. Phase 2 — macOS native app (Tauri)  ✅ built

A double-clickable `ytdown.app` that does the same job with no browser and no server, reusing the React UI.

- **Add Tauri:** `npm i -D @tauri-apps/cli @tauri-apps/api`, then `npx tauri init` → `src-tauri/` (Rust). `tauri.conf.json` points at the Vite dev server (dev) and `dist/` (build), and bundles `download.sh` as a resource.
- **Rust backend** (`src-tauri/src/lib.rs`): a `#[tauri::command] download(url, format)` that validates the URL (same youtube allowlist), serializes one job, `Command::new("bash").args([script, url, format, outdir])`, streams each output line via `app.emit("download-log", line)`, and returns the saved file path. It prepends the Homebrew bin dirs to `PATH` so a Finder-launched `.app` finds `yt-dlp`/`ffmpeg`.
- **Frontend adapter** (`src/api.ts`): `window.__TAURI_INTERNALS__` present → `invoke("download", …)` + `listen("download-log", …)`; else the browser `fetch` path. `App.tsx` calls the adapter, otherwise unchanged. The native app saves straight to `~/Downloads` — no `/api/file` round-trip.
- **Build:** `npx tauri dev` (native window + HMR), `npx tauri build` → `src-tauri/target/release/bundle/macos/ytdown.app` (+ `.dmg`, ~8 MB).
- **Distribution:** unsigned (Gatekeeper bypass on first launch); the receiving Mac needs `yt-dlp`/`ffmpeg` (or bundle them as sidecars), and `tauri build --target universal-apple-darwin` for Intel + Apple Silicon. (See §12.)

---

## 10. Security (local)

- **Injection guard:** the URL is passed to the spawned process as an argument, never concatenated into a shell string (true for both the Node and the Rust backends); the host is validated against an allowlist first.
- **Serialize:** one job at a time.
- **Phase 1 binds `127.0.0.1`** — the local server is never network-reachable.

---

## 11. Operational caveats

- **Keep yt-dlp fresh:** `yt-dlp -U` (or `brew upgrade yt-dlp`) — YouTube changes break old versions.
- **Two copies, locally:** the Phase-1 web app saves to `downloads/` *and* the browser saves its own copy; the native app saves once to `~/Downloads`.

---

## 12. Possible later additions

- **Bundle yt-dlp/ffmpeg as Tauri sidecars** → a fully self-contained `.app` (no `brew` needed on another Mac).
- **Universal build** (`--target universal-apple-darwin`) so the `.app` runs on Intel + Apple Silicon.
- Auto-cleanup / "delete after download"; playlist support; a quality picker.

Each is an isolated add-on.
