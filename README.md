# ytdown

A small personal app to download a YouTube video as **MP3** (audio) or **MP4** (video). Paste a URL, pick a format, and the file is saved. The actual downloading is your own `yt-dlp` command, kept in a swappable `download.sh`.

It comes in two forms, both built from the **same React + TypeScript UI**:

- **Local web app** (Phase 1) — runs in your browser at `http://127.0.0.1:5173`, served by a small TypeScript Node server.
- **macOS native app** (Phase 2) — a real `ytdown.app` (built with **Tauri**) with no browser and no server; a Rust backend runs the download.

> **Personal-use only.** Download content you own, that is public-domain/Creative-Commons, or that you have the right to save, and respect YouTube's Terms of Service.

## Requirements

- `yt-dlp` and `ffmpeg` — `brew install yt-dlp ffmpeg`
- Node.js ≥ 18 — `brew install node`
- Rust (only for the native app) — `brew install rust`

## Run

**Web app (Phase 1):**

```bash
npm install
npm run dev          # → http://127.0.0.1:5173  (hot-reload)
# or the production build:
npm run build && npm start
```

**Native macOS app (Phase 2):**

```bash
npm install
npx tauri dev        # native window with hot-reload
npx tauri build      # → src-tauri/target/release/bundle/macos/ytdown.app (+ .dmg)
```

## Customize

Edit `download.sh` — it's the only file with `yt-dlp` flags (MP3 = best audio → 64K; MP4 = best video ≤1440p merged with best audio). Both backends treat it as a black box: three args in (`url`, `format`, `outdir`), a file out.

## Docs

- [`PLAN.md`](./PLAN.md) — what it is and how it's built (the two phases).
- [`HOW-IT-WORKS.md`](./HOW-IT-WORKS.md) — implementation walkthrough.
- Korean renderings: `downloads/PLAN_KO.html`, `downloads/HOW-IT-WORKS_KO.html`.

## Notes

- A VPS / public-hosting phase was considered but **decided against**: it's a single-user personal tool, and running `yt-dlp` from a datacenter IP triggers YouTube's bot checks. The local web app + native app cover the need.
- The native app is **unsigned**; the first launch needs a one-time Gatekeeper bypass (right-click → **Open**, or System Settings → Privacy & Security → **Open Anyway**).
- Sharing the `.app`/`.dmg` with someone else: their Mac needs `yt-dlp` + `ffmpeg` installed too (or bundle them as Tauri sidecars), and the build is Apple-Silicon-only unless built `--target universal-apple-darwin`.
