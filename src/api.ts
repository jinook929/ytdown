// ───────────────────────────────────────────────────────────────────────────
// 다운로드 백엔드 어댑터 (Phase 1/3 브라우저 ↔ Phase 2 Tauri 네이티브).
// App.tsx는 download() 하나만 호출합니다. 실행 환경에 따라:
//   - 브라우저(Phase 1/3): HTTP fetch 로 Node 서버에 요청
//   - Tauri 창(Phase 2):  invoke() 로 Rust 커맨드를 호출
// 덕분에 UI 코드는 환경이 바뀌어도 그대로입니다.
//
// TODO(i18n-comments): 학습용 한국어 주석은 임시. 최종적으로 영어 번역 또는 제거.
// ───────────────────────────────────────────────────────────────────────────

import type { Format } from "./types";

// 지금 Tauri 네이티브 창 안에서 도는지 판별.
// Tauri는 실행 시 전역 window.__TAURI_INTERNALS__ 를 주입하므로 그걸로 구분합니다.
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export interface DownloadResult {
  // 브라우저: 파일 이름(basename). Tauri: 저장된 전체 경로.
  file: string;
}

// onLog: 진행 로그 텍스트(누적 전체)가 갱신될 때마다 호출 — 실시간 표시용.
export async function download(
  url: string,
  format: Format,
  onLog: (text: string) => void,
): Promise<DownloadResult> {
  // 환경에 맞는 경로로 분기. 둘 다 같은 모양(파일명 반환 + 로그 콜백)을 약속합니다.
  return isTauri()
    ? downloadViaTauri(url, format, onLog)
    : downloadViaFetch(url, format, onLog);
}

// ── Phase 2: Tauri (invoke + 이벤트) ──
async function downloadViaTauri(
  url: string,
  format: Format,
  onLog: (text: string) => void,
): Promise<DownloadResult> {
  // 동적 import: 브라우저 빌드에서는 이 청크가 로드되지 않습니다(isTauri()가 false).
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");

  // Rust가 한 줄씩 emit("download-log", line) 하는 것을 구독해 누적 표시.
  let buffer = "";
  const unlisten = await listen<string>("download-log", (e) => {
    buffer += e.payload + "\n";
    onLog(buffer);
  });
  try {
    // Rust의 #[tauri::command] download(url, format) 호출 → 저장된 파일 경로 반환.
    const file = await invoke<string>("download", { url, format });
    return { file };
  } finally {
    unlisten(); // 이벤트 구독 해제(누수 방지) — 성공/실패 무관하게 항상.
  }
}

// ── Phase 1/3: 브라우저 fetch(스트리밍) ──
async function downloadViaFetch(
  url: string,
  format: Format,
  onLog: (text: string) => void,
): Promise<DownloadResult> {
  const res = await fetch("/api/download", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, format }),
  });
  // 검증 실패(400)/사용 중(429)이면 본문을 읽어 예외로.
  if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
  if (!res.body) throw new Error("No response stream");

  // 응답 본문을 조각씩 읽어 누적(실시간 로그). 마지막 줄의 표식이 결과.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    onLog(buffer);
  }
  const fileMatch = buffer.match(/\n__FILE__ (.+)\n?$/);
  const errMatch = buffer.match(/\n__ERROR__ (.+)\n?$/);
  if (fileMatch) return { file: fileMatch[1] };
  if (errMatch) throw new Error(errMatch[1]);
  throw new Error("Unexpected end of stream");
}
