# ytdown — How This App Is Built

A walkthrough of how **ytdown** is actually implemented, based on the code as it stands. Where `PLAN.md` describes *what to build and how to deploy it*, this document explains *how the working app fits together* — the request flow, each file's job, and the design decisions behind them.

The app is a **React + TypeScript** single-page UI (built with Vite) talking to a small **TypeScript Node server**. The server runs your `yt-dlp` command, streams the live log back to the browser, and hands you the finished file. The download contract is unchanged from the original vanilla version — only the UI and the server's language/build changed.

> **Where this fits in the 3-phase plan:** this walkthrough describes **Phase 1** — the local browser + server app, the part that exists today. **Phase 2** (a macOS native app via **Tauri**, reusing this same React UI through a Rust backend) and **Phase 3** (the VPS deploy) are described in `PLAN.md`. This document will gain a Phase-2 section once that app is built; for now it documents the working Phase-1 code.

---

## 1. The big picture

```
Browser (React SPA) ──POST /api/download {url,format}──▶  Node server (server.ts, 127.0.0.1)
   ▲                                                          │ spawn("bash", [download.sh, …])
   │  live log (streamed response body)                       ▼
   │                                                      download.sh ──▶ yt-dlp + ffmpeg
   │                                                          │            → downloads/<title>.<ext>
   └──GET /api/file/<name> (attachment)◀──────────────────────┘  final "__FILE__ <name>" line = result
```

One request does the whole job. The server streams `yt-dlp`'s output straight into the HTTP response as it runs, and the **last line** of that stream is a sentinel — either `__FILE__ <name>` (success) or `__ERROR__ <message>` (failure). The browser reads the stream live, then parses that final line to know what happened.

The browser never talks to YouTube; only the server does (through your script).

**Dev vs production** is the one new wrinkle (see §6): in dev, Vite serves the React app with hot-reload and *proxies* `/api/*` to the Node server; in production, Vite builds the app to `dist/` and the same Node server serves those static files **and** the API.

---

## 2. File structure

```
ytdown/
├── index.html             # Vite entry: an empty <div id="root"> + the module script
├── src/
│   ├── main.tsx           # mounts <App/> into #root
│   ├── App.tsx            # the whole UI: state, the form, the streaming fetch
│   ├── App.css            # styles (light/dark)
│   └── types.ts           # shared types (Format = "mp3" | "mp4")
├── server/
│   └── server.ts          # backend: routing, validation, spawn, streaming, static + file serving
├── download.sh            # YOUR yt-dlp commands — the only file you customize
├── vite.config.ts         # React plugin + dev proxy (/api → 127.0.0.1:5174)
├── tsconfig.json          # frontend TS config
├── tsconfig.server.json   # backend TS config (typecheck only; tsx runs it)
├── package.json           # deps + scripts (dev / build / start)
├── dist/                  # Vite build output (gitignored)
└── downloads/             # output files land here (gitignored)
```

There **is** a build step and `node_modules` now (React, Vite, TypeScript). The trade for that cost: a typed, component-based UI with hot-reload in dev.

---

## 3. The frontend (React + TypeScript)

### 3.1 Entry: `index.html` → `main.tsx`

`index.html` is almost empty — just `<div id="root"></div>` and `<script type="module" src="/src/main.tsx">`. `main.tsx` finds that div and mounts the app:

```tsx
createRoot(document.getElementById("root")!).render(
  <StrictMode><App /></StrictMode>,
);
```

The `!` is a TypeScript non-null assertion (the root div always exists). `StrictMode` only affects development — it double-invokes some logic to surface bugs.

### 3.2 State: `App.tsx`

The UI is one component. Everything that can change on screen is React **state** (`useState`) — because setting state is what tells React to re-render. Plain variables wouldn't update the screen.

| State | Why |
|---|---|
| `url` | the input field's value (controlled input) |
| `format: Format` | `"mp3" \| "mp4"`, typed so a bad value can't compile |
| `busy` | disables the button / shows "Downloading…" |
| `log` | the streamed progress text, shown in a `<pre>` |
| `status` | `{ kind: "ok" \| "err"; text; file? } \| null` — the result line |

`format` uses the `Format` union from `types.ts`, so the radios can only ever set a valid value.

### 3.3 The submit handler — same streaming protocol, in React

`handleSubmit` is `async` because it awaits the network stream. It:

1. `e.preventDefault()` — stop the form from reloading the page (it's an SPA).
2. Resets state (`busy=true`, clears `log`/`status`).
3. `fetch("/api/download", { method:"POST", body: JSON.stringify({ url, format }) })`. If `!res.ok` (a 400/429), it reads the body text and throws it.
4. **Reads the streamed body incrementally** with `res.body.getReader()` + `TextDecoder`, in a `for (;;)` loop that `break`s when `done` is true, appending each chunk to `log` so you watch `yt-dlp` live.
5. Matches the accumulated text against the sentinels: `__FILE__ <name>` → set an "ok" status and auto-start the download; `__ERROR__ <message>` → throw it.
6. `catch` funnels every failure into an "err" status (using `err instanceof Error` to read the message safely from `unknown`).
7. `finally` always re-enables the button.

The JSX then renders conditionally: `{status && …}` shows the result line only when there is one, `{log && <pre>…}` shows the log only once it has content. This is the same sentinel contract as before — only the DOM updates now go through React state instead of manual `document` calls.

---

## 4. The server (`server/server.ts`)

Plain `node:http`, now in TypeScript (run directly by `tsx`, no compile step). It binds to **`127.0.0.1` only** so it is never directly reachable from the network — even on the VPS, where nginx is the public face.

### 4.1 Routing

A single `http.createServer` handler dispatches by method + path:

| Method & path | Handler | What it does |
|---|---|---|
| `POST /api/download` | `handleDownload` | validates, runs the job, streams the log |
| `GET /api/file/<name>` | `handleFile` | streams a finished file as a download |
| `GET <anything else>` | `serveFrontend` | serves the built SPA from `dist/` |

### 4.2 One job at a time

A module-level `let busy = false` serializes downloads: `handleDownload` rejects with **`429`** while a job runs and flips `busy` back on the child's `error`/`close`. The target VPS has 2 GB RAM, and a single serial job keeps the streamed log unambiguous.

### 4.3 Validating the request

It reads the POST body capped at 4 KB (only a tiny JSON is expected), then:

- **`url`** — `isValidYouTubeUrl()` parses it with `new URL()` (in a `try/catch`, since bad input throws) and requires `https:` **and** a hostname in an explicit allowlist (`youtube.com`, `www.`/`m.`/`music.youtube.com`, `youtu.be`). It's typed as a `raw is string` type guard, so after it returns true TypeScript treats `url` as a `string`.
- **`format`** — must be exactly `"mp3"` or `"mp4"`.

Validation happens **before** anything is spawned.

### 4.4 Running the download and streaming the log

1. Snapshot the current filenames in `downloads/` into a `Set` (`before`) to detect the new file afterward.
2. Write a `200` with `text/plain` + `no-cache`, then keep the response open as the live-log channel.
3. Spawn the script — two deliberate choices:

   ```ts
   const child = spawn("bash", [SCRIPT, url, format, DOWNLOADS_DIR], { cwd: PROJECT });
   ```
   - **Args array, never a shell string** → `url` is a separate argument, so there's no shell interpolation and no command-injection surface.
   - **Via `bash <script>`** so the shebang and `set -o pipefail` are honored regardless of the execute bit.
4. Pipe `child.stdout`/`stderr` into the response with `res.write(d)` — the live log.

On finish: `error` → `\n__ERROR__ <message>\n`; non-zero `close` → `\n__ERROR__ download failed (exit <code>)\n`; exit 0 → diff `downloads/` against `before`, take the newest new file (`newestFile()` compares `mtimeMs` in a `for…of` loop), and end with `\n__FILE__ <name>\n`. The newest-file diff is how the server learns the output name without `yt-dlp` reporting it.

### 4.5 Serving the SPA and the finished file

- `serveFrontend` serves `dist/`. `/` → `dist/index.html`; other paths map into `dist/` (with a `startsWith(DIST_DIR)` guard against `../` escapes and a content-type lookup by extension), falling back to `index.html`. If `dist/` doesn't exist yet, it returns a "run `npm run dev`" hint (in dev, Vite serves the UI; this server is only hit for `/api`).
- `handleFile` turns `/api/file/<name>` into a download. Its key job is the **path-traversal guard**: `path.basename(name)` strips any directory components, so `../../etc/passwd` can never escape `downloads/`. It then `stat`s the file, sets `Content-Disposition: attachment` with a UTF-8-encoded filename (non-ASCII titles survive), and pipes it with `fs.createReadStream(file).pipe(res)` (streamed, so an 80 MB MP4 never sits in memory).

---

## 5. The download script (`download.sh`)

Unchanged from the vanilla version — the app treats it as a black box: three args in, a file out, exit 0 on success. The server calls `bash download.sh "<URL>" "<mp3|mp4>" "<OUTDIR>"`. It runs under `set -euo pipefail` and writes to `$OUTDIR/%(title)s.%(ext)s`:

- **MP3** — `bestaudio`, extracted/re-encoded to MP3 at 64K.
- **MP4** — best video ≤ 1440p + best audio, merged into MP4 (ffmpeg does the merge).
- `--no-mtime` sets the output's timestamp to "now," which is what makes the newest-file detection (§4.4) reliable.

Because the server depends only on the script's *contract*, you can change any flag here without touching `server.ts`.

---

## 6. Dev vs production

This is the one genuinely new piece versus the vanilla app.

- **Dev** (`npm run dev`): runs two processes via `concurrently` — Vite on `127.0.0.1:5173` (serves the React app with hot-reload) and the API server on `5174` (`PORT=5174 tsx watch server/server.ts`). `vite.config.ts` proxies `/api/*` from 5173 → 5174, so the browser code just calls `fetch("/api/...")` with no CORS. Editing `App.tsx` updates the page instantly; editing `server.ts` restarts the API via `tsx watch`.
- **Production** (`npm run build` → `npm start`): `build` typechecks both `tsconfig`s and bundles the app to `dist/`; `start` runs `tsx server/server.ts`, which serves `dist/` **and** `/api` on a single port (5173). This is exactly what the VPS (PLAN §9) runs behind nginx.

---

## 7. Design decisions, in one place

- **React + TypeScript, Vite-built.** A typed, component-based UI with hot-reload — at the cost of a build step and `node_modules` (the deliberate trade made in v2).
- **One server for static + API in prod.** No separate static host; `server.ts` serves `dist/` and `/api` together, so deployment is still "one process behind nginx."
- **Bind to `127.0.0.1`.** The app is never the public face; on the VPS, nginx terminates TLS, enforces the password, and reverse-proxies to it.
- **Streaming response as the log.** The single POST response *is* the live log, and its last line is the result — no WebSocket or polling.
- **Security by construction.** Args-array `spawn` (no shell injection), an explicit host allowlist (no SSRF), `path.basename` on file serving (no path traversal), a 4 KB body cap, and serialized jobs.

---

## 8. Running it

```bash
# prerequisites (macOS)
brew install yt-dlp ffmpeg node

# install JS deps once
npm install

# develop with hot-reload (Vite + API)
npm run dev          # → http://127.0.0.1:5173

# or run the production build locally
npm run build && npm start   # → http://127.0.0.1:5173
```

Open the page, paste a YouTube link, pick MP3 or MP4, and hit Download. The log streams live; the file drops into `downloads/` and the browser download starts automatically.

For putting this behind HTTPS + a password on a VPS, see `PLAN.md` §9 (Phase B).
