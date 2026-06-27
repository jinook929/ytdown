import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./App.css";

// 앱의 진입점(entry point). 하는 일은 단 하나: <App/> 을 실제 DOM에 붙이기.
// TODO(i18n-comments): 학습용 한국어 주석은 임시. 최종적으로 영어 번역 또는 제거.

// document.getElementById("root") 는 index.html 의 <div id="root"> 를 찾습니다.
// 반환 타입이 HTMLElement | null 이라, 뒤의 "!" 로 "절대 null 아님"을 TS에 약속합니다
// (root div는 항상 존재하므로 안전).
const rootElement = document.getElementById("root")!;

// createRoot(...).render(...) 가 React 18+ 의 표준 마운트 방식입니다.
// StrictMode 는 개발 중에만 동작하며, 잠재적 버그를 더 잘 드러내려고 일부 로직을
// 일부러 두 번 실행합니다(운영 빌드에는 영향 없음).
createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
