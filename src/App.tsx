// ───────────────────────────────────────────────────────────────────────────
// 화면(UI) 전체를 그리는 React 컴포넌트. (Phase 1 브라우저 / Phase 2 Tauri 공용)
// 흐름: URL 입력 + 형식 선택 → "Download" → download() 어댑터(api.ts)가
//       환경에 맞게(브라우저 fetch / Tauri invoke) 백엔드를 호출 → 실시간 로그 →
//       완료되면 파일을 받음(브라우저) 또는 로컬에 저장됨(Tauri).
//
// TODO(i18n-comments): 아래 학습용 한국어 주석은 임시입니다. 최종적으로 영어로
//   번역하거나 제거할 것. (요청: 2026-06-27, 학습 목적)
// ───────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { Format } from "./types";
import { checkDeps, download, isTauri } from "./api";

// 네이티브 창인지 한 번만 계산해 둠(렌더/분기에서 재사용). 실행 중 바뀌지 않음.
const NATIVE = isTauri();

export function App() {
  // ── 상태(state) ── 화면이 바뀌어야 하는 값은 useState. set 해야 React가 다시 그림.
  const [url, setUrl] = useState("");
  const [format, setFormat] = useState<Format>("mp4");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState("");
  const [status, setStatus] = useState<
    { kind: "ok" | "err"; text: string; file?: string } | null
  >(null);

  // First-run dependency gate (native app only). null = still checking;
  // [] = all present; ["yt-dlp", …] = these must be installed before use.
  // In the browser the tools live on the server, so we skip the check entirely.
  const [missing, setMissing] = useState<string[] | null>(NATIVE ? null : []);

  function recheckDeps() {
    if (!NATIVE) return;
    setMissing(null);
    checkDeps()
      .then(setMissing)
      .catch(() => setMissing([]));
  }

  // Run the check once on mount (native only).
  useEffect(recheckDeps, []);

  async function handleSubmit(e: FormEvent) {
    // 폼 기본 새로고침 막기(SPA).
    e.preventDefault();

    // 작업 시작: 버튼 잠그고 이전 로그/상태 초기화.
    setBusy(true);
    setStatus(null);
    setLog("");

    try {
      // 어댑터 호출. 세 번째 인자는 "로그가 갱신될 때마다" 부르는 콜백 → 바로 setLog.
      // 브라우저든 네이티브든 이 한 줄이 동일하게 동작(차이는 api.ts가 숨김).
      const { file } = await download(url.trim(), format, setLog);

      setStatus({ kind: "ok", text: NATIVE ? "Saved:" : "Done:", file });

      // 브라우저는 파일이 서버에 있으므로 받아와야 함. 네이티브는 이미 로컬 저장됨.
      if (!NATIVE) triggerDownload(file);
    } catch (err) {
      // 모든 실패가 여기로. err가 unknown이라 instanceof로 메시지를 안전 추출.
      const text = err instanceof Error ? err.message : String(err);
      setStatus({ kind: "err", text: `Download failed. ${text}` });
    } finally {
      // 성공/실패 무관 항상 버튼 복구.
      setBusy(false);
    }
  }

  // (브라우저 전용) /api/file 링크를 잠깐 만들어 클릭 → 브라우저 다운로드 시작.
  function triggerDownload(file: string) {
    const a = document.createElement("a");
    a.href = `/api/file/${encodeURIComponent(file)}`;
    a.download = file;
    a.click();
  }

  return (
    <main className="app">
      <h1>YouTube Downloader</h1>
      <p className="sub">Paste a link, pick a format, download as MP3 or MP4.</p>

      {missing === null ? (
        <p className="note">Checking dependencies…</p>
      ) : missing.length > 0 ? (
        <InstallGuide missing={missing} onRecheck={recheckDeps} />
      ) : (
        <>
          <form onSubmit={handleSubmit}>
            <input
              type="url"
              placeholder="Paste a YouTube link"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
              autoComplete="off"
              spellCheck={false}
            />

            <fieldset>
              <label className="fmt">
                <input
                  type="radio"
                  name="format"
                  checked={format === "mp4"}
                  onChange={() => setFormat("mp4")}
                />
                MP4 (video)
              </label>
              <label className="fmt">
                <input
                  type="radio"
                  name="format"
                  checked={format === "mp3"}
                  onChange={() => setFormat("mp3")}
                />
                MP3 (audio)
              </label>
            </fieldset>

            <button type="submit" disabled={busy}>
              {busy ? "Downloading…" : "Download"}
            </button>
          </form>

          {status && (
            <p className={`status ${status.kind}`}>
              {status.text}{" "}
              {status.file &&
                // 네이티브: 이미 로컬에 저장됐으니 경로만 표시. 브라우저: 다운로드 링크.
                (NATIVE ? (
                  <span>{status.file}</span>
                ) : (
                  <a href={`/api/file/${encodeURIComponent(status.file)}`} download={status.file}>
                    {status.file}
                  </a>
                ))}
            </p>
          )}

          {log && <pre className="log">{log}</pre>}

          <p className="note">
            {NATIVE
              ? "Native app. Files are saved to your Downloads folder."
              : "Local, single-user. Files are saved to downloads/."}
          </p>
        </>
      )}
    </main>
  );
}

// First-run guide shown (native only) when required command-line tools are missing.
// All copy is intentionally in English regardless of the app's language.
function InstallGuide({
  missing,
  onRecheck,
}: {
  missing: string[];
  onRecheck: () => void;
}) {
  const cmd = `brew install ${missing.join(" ")}`;
  return (
    <section className="guide">
      <p className="status err">Setup needed — some required tools are missing.</p>
      <p className="guide-text">
        This app relies on command-line tools that aren’t installed yet:{" "}
        <strong>{missing.join(", ")}</strong>.
      </p>
      <p className="guide-text">
        Open <strong>Terminal</strong> and run:
      </p>
      <pre className="cmd">{cmd}</pre>
      <div className="guide-actions">
        <button type="button" onClick={() => navigator.clipboard?.writeText(cmd)}>
          Copy command
        </button>
        <button type="button" className="secondary" onClick={onRecheck}>
          Re-check
        </button>
      </div>
      <p className="note">
        Requires <strong>Homebrew</strong>. If you don’t have it, install it from
        brew.sh first, then run the command above and click Re-check.
      </p>
    </section>
  );
}
