import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite 설정. `npm run dev:web`(개발)와 `npm run build`(배포 번들) 양쪽에서 쓰입니다.
// TODO(i18n-comments): 학습용 한국어 주석은 임시. 최종적으로 영어 번역 또는 제거.
export default defineConfig({
  // react() 플러그인: .tsx 의 JSX 변환 + 개발 중 HMR(코드 저장 시 즉시 반영)을 켜줍니다.
  plugins: [react()],
  server: {
    // 개발용 프런트엔드 서버 포트. 브라우저는 여기(5173)에 접속합니다.
    port: 5173,
    // 프런트엔드에서 호출하는 /api/* 요청을 백엔드(API 서버, 5174)로 그대로 넘깁니다.
    // 이렇게 두면 브라우저 코드에서는 그냥 fetch("/api/...") 라고만 쓰면 됩니다(CORS 불필요).
    proxy: {
      "/api": "http://127.0.0.1:5174",
    },
  },
  build: {
    // 배포 빌드 결과물이 들어갈 폴더. 운영 시 server.ts 가 이 dist/ 를 정적으로 서빙합니다.
    outDir: "dist",
  },
});
