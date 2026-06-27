// ───────────────────────────────────────────────────────────────────────────
// 화면(UI) 전체를 그리는 React 컴포넌트.
// 흐름: 사용자가 URL 입력 + 형식 선택 → "Download" 클릭 → 서버에 요청 →
//       서버가 보내주는 실시간 로그를 화면에 흘려보여주고 → 끝나면 파일을 받음.
//
// TODO(i18n-comments): 아래 학습용 한국어 주석은 임시입니다. 최종적으로 영어로
//   번역하거나 제거할 것. (요청: 2026-06-27, 학습 목적)
// ───────────────────────────────────────────────────────────────────────────

import { useState } from "react";
import type { FormEvent } from "react";
import type { Format } from "./types";

export function App() {
  // ── 상태(state) ──
  // React에서 "화면이 바뀌어야 하는 값"은 useState로 둡니다. setX 를 호출하면
  // React가 컴포넌트를 다시 그려(re-render) 화면에 반영합니다. 그냥 일반 변수로
  // 두면 값이 바뀌어도 화면이 다시 그려지지 않습니다 — 그래서 useState가 필요.

  // 입력창의 유튜브 링크.
  const [url, setUrl] = useState("");
  // 선택된 형식. 제네릭 <Format> 으로 "mp3" | "mp4" 만 허용되게 타입을 좁힘.
  const [format, setFormat] = useState<Format>("mp4");
  // 다운로드 진행 중 여부 — 버튼 비활성화/문구 변경에 사용.
  const [busy, setBusy] = useState(false);
  // 서버가 흘려보내는 진행 로그(텍스트). 누적해서 <pre> 에 보여줌.
  const [log, setLog] = useState("");
  // 화면 하단 상태 메시지. kind 로 성공/실패를 구분해 색을 바꿈.
  // 객체 또는 null — 아직 아무 일도 없으면 null.
  const [status, setStatus] = useState<
    { kind: "ok" | "err"; text: string; file?: string } | null
  >(null);

  // ── 제출 핸들러 ──
  // form 의 onSubmit 에 연결. async 인 이유: 안에서 네트워크 응답을 await 로
  // 기다리기 때문(다운로드가 끝날 때까지 스트림을 읽어야 함).
  async function handleSubmit(e: FormEvent) {
    // 폼 기본 동작(페이지 새로고침)을 막음 — SPA에서는 새로고침하면 안 되니까.
    e.preventDefault();

    // 작업 시작: 버튼 잠그고, 이전 로그/상태를 초기화.
    setBusy(true);
    setStatus(null);
    setLog("");

    try {
      // 서버에 다운로드 요청. body에 {url, format} 을 JSON으로 실어 보냄.
      const res = await fetch("/api/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim(), format }),
      });

      // res.ok 는 상태코드가 200~299일 때만 true. 검증 실패(400)나 사용 중(429)이면
      // 여기서 본문(에러 메시지)을 읽어 예외로 던짐 → 아래 catch 로 감.
      if (!res.ok) {
        throw new Error((await res.text()) || `HTTP ${res.status}`);
      }

      // ── 스트리밍 응답 읽기 ──
      // 서버는 응답 본문(body)에 yt-dlp 로그를 "실시간으로" 흘려보냅니다.
      // 그래서 한 번에 다 받는 게 아니라, reader 로 조각(chunk)씩 읽습니다.
      // res.body 는 ReadableStream | null 이므로 없으면 방어적으로 예외.
      if (!res.body) throw new Error("No response stream");
      const reader = res.body.getReader();
      // 네트워크로 오는 바이트(Uint8Array)를 사람이 읽는 문자열로 바꾸는 디코더.
      const decoder = new TextDecoder();
      let buffer = "";

      // 무한 루프(for(;;))로 스트림이 끝날 때까지 계속 읽습니다.
      // done === true 가 되면(서버가 응답을 닫으면) break 로 빠져나옴.
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        // stream:true 는 "아직 더 올 수 있다"는 뜻 — 멀티바이트(한글 등) 문자가
        // 조각 경계에서 잘려도 다음 조각과 합쳐 올바르게 디코딩되게 해줍니다.
        buffer += decoder.decode(value, { stream: true });
        // 받은 만큼 즉시 로그 화면에 반영(실시간 진행 표시).
        setLog(buffer);
      }

      // ── 결과 판별 ──
      // 서버는 스트림의 마지막 줄에 "약속된 표식(sentinel)"을 하나 붙여 보냅니다:
      //   성공: "\n__FILE__ <파일명>\n"   실패: "\n__ERROR__ <메시지>\n"
      // 그 마지막 줄을 정규식으로 뽑아 성공/실패를 구분합니다.
      const fileMatch = buffer.match(/\n__FILE__ (.+)\n?$/);
      const errMatch = buffer.match(/\n__ERROR__ (.+)\n?$/);

      if (fileMatch) {
        // [1] 은 정규식 괄호 (.+) 가 잡은 값 = 파일명.
        const file = fileMatch[1];
        setStatus({ kind: "ok", text: "Done:", file });
        // 파일을 실제로 내려받게 브라우저를 그 다운로드 URL로 유도(자동 클릭).
        triggerDownload(file);
      } else if (errMatch) {
        // 서버가 일을 시작은 했지만 yt-dlp 가 실패한 경우.
        throw new Error(errMatch[1]);
      } else {
        // 표식이 없으면 스트림이 비정상 종료된 것.
        throw new Error("Unexpected end of stream");
      }
    } catch (err) {
      // fetch 실패, 검증 실패, yt-dlp 실패 등 모든 오류가 여기로 모입니다.
      // err 의 타입이 unknown 이므로 instanceof 로 좁혀 안전하게 메시지 추출.
      const text = err instanceof Error ? err.message : String(err);
      setStatus({ kind: "err", text: `Download failed. ${text}` });
    } finally {
      // 성공이든 실패든 항상 버튼을 다시 풀어줌(finally 의 핵심 용도).
      setBusy(false);
    }
  }

  // 파일명을 받아 <a download> 를 잠깐 만들어 클릭 → 브라우저 다운로드 시작.
  // (자동 클릭이 브라우저에 막히면 화면의 링크를 직접 누르면 됨.)
  function triggerDownload(file: string) {
    const a = document.createElement("a");
    a.href = `/api/file/${encodeURIComponent(file)}`;
    a.download = file;
    a.click();
  }

  // ── 화면(JSX) ──
  return (
    <main className="app">
      <h1>YouTube Downloader</h1>
      <p className="sub">Paste a link, pick a format, download as MP3 or MP4.</p>

      <form onSubmit={handleSubmit}>
        <input
          type="url"
          placeholder="Paste a YouTube link"
          value={url}
          // 입력할 때마다 상태를 갱신(controlled input). 이래야 value 와 화면이 항상 일치.
          onChange={(e) => setUrl(e.target.value)}
          required
          autoComplete="off"
          spellCheck={false}
        />

        <fieldset>
          {/* 두 라디오를 배열로 만들지 않고 그대로 두 개 둠 — 단순함이 더 읽기 쉬움. */}
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

        {/* busy 일 때 버튼을 잠그고 문구를 바꿔 "진행 중"을 알려줌. */}
        <button type="submit" disabled={busy}>
          {busy ? "Downloading…" : "Download"}
        </button>
      </form>

      {/* status 가 있을 때만 메시지 줄을 렌더. && 는 "왼쪽이 참이면 오른쪽을 그림". */}
      {status && (
        <p className={`status ${status.kind}`}>
          {status.text}{" "}
          {status.file && (
            <a href={`/api/file/${encodeURIComponent(status.file)}`} download={status.file}>
              {status.file}
            </a>
          )}
        </p>
      )}

      {/* 로그가 있을 때만 <pre> 표시. */}
      {log && <pre className="log">{log}</pre>}

      <p className="note">
        Local, single-user. Files are saved to <code>downloads/</code>.
      </p>
    </main>
  );
}
