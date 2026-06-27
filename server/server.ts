// ───────────────────────────────────────────────────────────────────────────
// 백엔드 서버 (TypeScript). 하는 일:
//   1) (운영 시) Vite가 빌드한 dist/ 정적 파일을 서빙해 화면을 띄움
//   2) POST /api/download → download.sh 실행 + 진행 로그를 실시간 스트리밍
//   3) GET  /api/file/<name> → 완성된 파일을 첨부(attachment)로 내려줌
// 보안상 항상 127.0.0.1 에만 바인딩(외부 직접 노출 금지). 의존성은 tsx로 .ts 직접 실행.
//
// TODO(i18n-comments): 아래 학습용 한국어 주석은 임시입니다. 최종적으로 영어로
//   번역하거나 제거할 것. (요청: 2026-06-27, 학습 목적)
// ───────────────────────────────────────────────────────────────────────────

import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ESM(.ts/.mjs)에는 __dirname 이 없어서 import.meta.url 로 직접 만듭니다.
// 이 파일은 server/ 안에 있으므로, 프로젝트 루트는 한 단계 위.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, "..");

// 포트는 환경변수 우선(개발 API는 5174), 없으면 5173. Number() 로 문자열→숫자 변환.
const PORT = Number(process.env.PORT) || 5173;
const HOST = "127.0.0.1";
const DIST_DIR = path.join(PROJECT, "dist");
const DOWNLOADS_DIR = path.join(PROJECT, "downloads");
const SCRIPT = path.join(PROJECT, "download.sh");

// downloads/ 가 없으면 서버 시작 시 만들어 둠(recursive: 중간 경로까지 생성).
fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

// 한 번에 한 작업만(2GB RAM, 그리고 로그가 뒤섞이지 않게). true=작업 중.
let busy = false;

// 허용 호스트를 Set 으로 둠 — has() 로의 조회가 빠르고 의도가 명확.
const ALLOWED_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);

// 입력 URL이 우리가 허용하는 유튜브 https 링크인지 검사.
// new URL()은 형식이 틀리면 throw 하므로 try/catch 로 막고 false 반환.
function isValidYouTubeUrl(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  // https 강제 + 호스트 화이트리스트. 둘 다 만족해야 통과.
  return u.protocol === "https:" && ALLOWED_HOSTS.has(u.hostname);
}

// 확장자 → Content-Type 매핑(정적 파일 서빙용). 모르면 octet-stream(그냥 바이너리).
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

function sendText(
  res: ServerResponse,
  status: number,
  body: string,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", ...headers });
  res.end(body);
}

// ── 라우팅 ──
// 모든 요청이 이 함수 하나로 들어옵니다. method + pathname 으로 분기.
const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
  const { pathname } = new URL(req.url ?? "/", `http://${req.headers.host}`);

  if (req.method === "POST" && pathname === "/api/download") {
    return handleDownload(req, res);
  }
  // startsWith 로 "/api/file/<무엇이든>" 을 잡고, 뒤의 파일명을 디코딩해 전달.
  if (req.method === "GET" && pathname.startsWith("/api/file/")) {
    return handleFile(res, decodeURIComponent(pathname.slice("/api/file/".length)));
  }
  if (req.method === "GET") {
    return serveFrontend(res, pathname);
  }
  sendText(res, 404, "Not found");
});

// 빌드된 SPA(dist/)를 서빙. 개발 중에는 dist/ 가 없을 수 있음(그땐 Vite가 화면 담당).
function serveFrontend(res: ServerResponse, pathname: string) {
  if (!fs.existsSync(DIST_DIR)) {
    return sendText(
      res,
      200,
      "Dev mode: run `npm run dev` and open http://127.0.0.1:5173 (Vite serves the UI).",
    );
  }
  // "/" 는 index.html 로. 그 외엔 요청 경로를 그대로 dist/ 아래에서 찾음.
  const rel = pathname === "/" ? "/index.html" : pathname;
  const file = path.join(DIST_DIR, path.normalize(rel));

  // 경로 보안: 정규화 후에도 반드시 dist/ 안이어야 함(상위로 탈출(../) 차단).
  if (!file.startsWith(DIST_DIR)) return sendText(res, 400, "Bad path");

  fs.readFile(file, (err, data) => {
    if (err) {
      // 없는 경로면 SPA 관례대로 index.html 로 폴백.
      return fs.readFile(path.join(DIST_DIR, "index.html"), (e2, html) => {
        if (e2) return sendText(res, 404, "Not built. Run `npm run build`.");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
      });
    }
    // ?? 는 "왼쪽이 null/undefined면 오른쪽" — 모르는 확장자면 octet-stream.
    const type = CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(data);
  });
}

// POST /api/download 처리.
function handleDownload(req: IncomingMessage, res: ServerResponse) {
  // 요청 본문은 조각으로 도착하므로 모아서 buffer 에 누적.
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
    // 본문은 작은 JSON뿐 — 비정상적으로 크면(공격 가능성) 연결을 끊음.
    if (body.length > 4096) req.destroy();
  });

  req.on("end", () => {
    // JSON 파싱은 실패할 수 있으니 try/catch. 형태를 명시해 타입 안전하게 받음.
    let parsed: { url?: unknown; format?: unknown };
    try {
      parsed = JSON.parse(body);
    } catch {
      return sendText(res, 400, "Bad JSON");
    }
    const { url, format } = parsed;

    // 순서대로 검증: 유튜브 URL → 형식 → 동시작업 여부. 하나라도 어긋나면 즉시 응답.
    if (!isValidYouTubeUrl(url)) return sendText(res, 400, "Invalid YouTube URL");
    if (format !== "mp3" && format !== "mp4") return sendText(res, 400, "Invalid format");
    if (busy) return sendText(res, 429, "Busy — one download at a time");

    busy = true;
    // 실행 전 downloads/ 에 이미 있던 파일 이름들을 기록. 끝난 뒤 "새로 생긴 파일"을
    // 찾기 위함(yt-dlp 가 만든 결과 파일명을 우리가 미리 알 수 없으므로).
    const before = new Set(fs.readdirSync(DOWNLOADS_DIR));

    // 응답 본문에 로그를 흘려보낼 것이므로 먼저 200 헤더만 보냄.
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache",
    });

    // bash 로 스크립트를 실행. 인자를 "배열"로 전달하는 게 핵심 — 셸 문자열로
    // 이어붙이지 않으므로 URL에 악성 문자가 있어도 명령 주입이 불가능(보안).
    const child = spawn("bash", [SCRIPT, url, format, DOWNLOADS_DIR], { cwd: PROJECT });

    // yt-dlp 의 표준출력/표준에러를 받는 즉시 클라이언트로 그대로 흘려보냄(실시간 로그).
    child.stdout.on("data", (d) => res.write(d));
    child.stderr.on("data", (d) => res.write(d));

    // 프로세스 자체를 못 띄운 경우(예: bash 없음).
    child.on("error", (err) => {
      busy = false;
      res.end(`\n__ERROR__ ${err.message}\n`);
    });

    // 프로세스 종료. code===0 이 성공.
    child.on("close", (code) => {
      busy = false;
      if (code !== 0) return res.end(`\n__ERROR__ download failed (exit ${code})\n`);
      // 실행 후 목록에서 before 에 없던 = 새로 생긴 파일만 추림.
      const fresh = fs.readdirSync(DOWNLOADS_DIR).filter((f) => !before.has(f));
      const newest = newestFile(fresh);
      if (!newest) return res.end(`\n__ERROR__ finished but no output file found\n`);
      // 마지막 줄에 약속된 표식 + 파일명. 프런트엔드가 이 줄을 보고 성공을 판단.
      res.end(`\n__FILE__ ${newest}\n`);
    });
  });
}

// 후보 파일들 중 수정시각(mtime)이 가장 최신인 것을 고름.
// for...of 로 하나씩 보며 "지금까지 본 최댓값"을 갱신하는 전형적인 패턴.
function newestFile(names: string[]): string | null {
  let best: string | null = null;
  let bestMtime = -1;
  for (const name of names) {
    try {
      const m = fs.statSync(path.join(DOWNLOADS_DIR, name)).mtimeMs;
      if (m > bestMtime) {
        bestMtime = m;
        best = name;
      }
    } catch {
      // 스캔 도중 사라진 파일은 무시.
    }
  }
  return best;
}

// 완성 파일을 다운로드로 내려줌.
function handleFile(res: ServerResponse, name: string) {
  // 경로 탈출 방지: basename 으로 디렉터리 부분을 모두 제거 → downloads/ 안의 파일만.
  const safe = path.basename(name);
  const file = path.join(DOWNLOADS_DIR, safe);
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return sendText(res, 404, "File not found");
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": st.size,
      // filename* 형식 + UTF-8 인코딩이라 한글 제목 파일명도 안전하게 전달됨.
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(safe)}`,
    });
    // 파일을 통째로 메모리에 올리지 않고 스트림으로 흘려보냄(큰 mp4도 안전).
    fs.createReadStream(file).pipe(res);
  });
}

server.listen(PORT, HOST, () => {
  console.log(`ytdown server -> http://${HOST}:${PORT}  (downloads -> ${DOWNLOADS_DIR})`);
});
