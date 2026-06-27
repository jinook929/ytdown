// ───────────────────────────────────────────────────────────────────────────
// Tauri 네이티브 백엔드 (Phase 2). 프런트엔드(React)가 invoke("download", …)로
// 호출하면, 여기서 download.sh 를 실행하고 진행 로그를 한 줄씩 이벤트로 흘려보냅니다.
// Phase 1/3의 Node 서버(server.ts)가 하던 일을 같은 방식으로 Rust가 합니다.
//
// TODO(i18n-comments): 학습용 한국어 주석은 임시. 최종적으로 영어 번역 또는 제거.
// ───────────────────────────────────────────────────────────────────────────

use std::collections::HashSet;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::SystemTime;
use tauri::{AppHandle, Emitter, Manager};

// 동시에 한 다운로드만(서버의 `busy` 플래그와 같은 개념). 끝나면 BusyGuard가 해제.
static BUSY: AtomicBool = AtomicBool::new(false);
struct BusyGuard;
impl Drop for BusyGuard {
    fn drop(&mut self) {
        BUSY.store(false, Ordering::SeqCst);
    }
}

// 허용 유튜브 호스트(server.ts의 화이트리스트와 동일). https + 호스트 둘 다 만족해야 통과.
fn is_valid_youtube_url(raw: &str) -> bool {
    match url::Url::parse(raw) {
        Ok(u) => {
            u.scheme() == "https"
                && matches!(
                    u.host_str(),
                    Some("youtube.com")
                        | Some("www.youtube.com")
                        | Some("m.youtube.com")
                        | Some("music.youtube.com")
                        | Some("youtu.be")
                )
        }
        Err(_) => false,
    }
}

// download.sh 위치: 개발 = 소스 트리(빌드 시점 매니페스트 기준 프로젝트 루트),
// 번들 = .app 안에 포함된 리소스. 둘 중 존재하는 쪽을 씀.
fn resolve_script(app: &AppHandle) -> Option<PathBuf> {
    let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("../download.sh");
    if dev.exists() {
        return Some(dev);
    }
    app.path()
        .resolve("download.sh", tauri::path::BaseDirectory::Resource)
        .ok()
        .filter(|p| p.exists())
}

// 저장 폴더: ~/Downloads (없으면 HOME, 그것도 없으면 임시 폴더).
fn downloads_dir() -> PathBuf {
    if let Some(home) = std::env::var_os("HOME") {
        let d = Path::new(&home).join("Downloads");
        if d.is_dir() {
            return d;
        }
        return PathBuf::from(home);
    }
    std::env::temp_dir()
}

// 실제 다운로드(블로킹). spawn_blocking 위에서 호출되어 UI(웹뷰)를 막지 않습니다.
fn run_download(app: AppHandle, url: String, format: String) -> Result<String, String> {
    // 검증은 무엇을 실행하기 전에 먼저.
    if !is_valid_youtube_url(&url) {
        return Err("Invalid YouTube URL".into());
    }
    if format != "mp3" && format != "mp4" {
        return Err("Invalid format".into());
    }
    // 동시 실행 차단: 이미 작업 중이면 거절. _guard가 drop될 때 자동 해제.
    if BUSY.swap(true, Ordering::SeqCst) {
        return Err("Busy — one download at a time".into());
    }
    let _guard = BusyGuard;

    let script = resolve_script(&app).ok_or("download.sh not found")?;
    let outdir = downloads_dir();

    // 실행 전 폴더의 파일 집합(끝난 뒤 "새로 생긴 파일"을 찾기 위함).
    let before: HashSet<PathBuf> = std::fs::read_dir(&outdir)
        .map(|rd| rd.flatten().map(|e| e.path()).collect())
        .unwrap_or_default();

    // Finder에서 실행된 .app은 PATH가 제한되어 brew의 yt-dlp/ffmpeg를 못 찾습니다.
    // 그래서 Homebrew 경로를 PATH 앞에 붙여 줍니다(개발/터미널 실행에도 안전).
    let path_env = format!(
        "/opt/homebrew/bin:/usr/local/bin:{}",
        std::env::var("PATH").unwrap_or_default()
    );

    // bash download.sh <url> <format> <outdir> — 인자를 "배열"로 전달(셸 문자열 아님 → 주입 불가).
    let mut child = Command::new("bash")
        .arg(&script)
        .arg(&url)
        .arg(&format)
        .arg(&outdir)
        .env("PATH", path_env)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to start bash: {e}"))?;

    // stderr는 별도 스레드로 "동시에" 읽습니다(한 파이프만 읽으면 다른 파이프가 가득 차 데드락).
    // yt-dlp의 진행률은 주로 stderr로 나오므로 이것도 로그로 흘려보냅니다.
    let stderr = child.stderr.take();
    let app_err = app.clone();
    let err_thread = std::thread::spawn(move || {
        let mut collected = String::new();
        if let Some(e) = stderr {
            for line in BufReader::new(e).lines().map_while(Result::ok) {
                let _ = app_err.emit("download-log", &line);
                collected.push_str(&line);
                collected.push('\n');
            }
        }
        collected
    });

    // stdout은 현재 스레드에서 한 줄씩 읽어 emit.
    if let Some(out) = child.stdout.take() {
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            let _ = app.emit("download-log", line);
        }
    }

    let stderr_text = err_thread.join().unwrap_or_default();
    let status = child.wait().map_err(|e| e.to_string())?;
    if !status.success() {
        let tail = stderr_text.trim().lines().last().unwrap_or("download failed");
        return Err(format!("download failed: {tail}"));
    }

    // 새로 생긴 파일 중 수정시각이 가장 최신인 것 = 결과 파일.
    let newest = std::fs::read_dir(&outdir)
        .map(|rd| rd.flatten().map(|e| e.path()).collect::<Vec<_>>())
        .unwrap_or_default()
        .into_iter()
        .filter(|p| p.is_file() && !before.contains(p))
        .max_by_key(|p| {
            std::fs::metadata(p)
                .and_then(|m| m.modified())
                .unwrap_or(SystemTime::UNIX_EPOCH)
        });

    match newest {
        Some(p) => Ok(p.to_string_lossy().to_string()),
        None => Err("finished but no output file found".into()),
    }
}

// 프런트엔드가 부르는 커맨드. async지만 실제 블로킹 일은 spawn_blocking으로 옮겨
// UI를 막지 않습니다.
#[tauri::command]
async fn download(app: AppHandle, url: String, format: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || run_download(app, url, format))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        // 위 download 커맨드를 프런트엔드에서 invoke 할 수 있도록 등록.
        .invoke_handler(tauri::generate_handler![download])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
