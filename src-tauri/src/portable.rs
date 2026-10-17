use std::path::PathBuf;
use tauri::AppHandle;
#[cfg(not(boaa_portable))]
use tauri::Manager;

#[cfg(boaa_portable)]
static PORTABLE_PAYLOAD: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/portable-payload.zip"));
#[cfg(boaa_portable)]
#[derive(Clone)]
pub(crate) struct PortableProfile {
    pub(crate) root: PathBuf,
    pub(crate) runtime: PathBuf,
    _lock: std::sync::Arc<std::fs::File>,
    _legacy_lock: Option<std::sync::Arc<std::fs::File>>,
}

#[cfg(boaa_portable)]
pub(crate) fn prepare() -> Result<PortableProfile, String> {
    use sha2::{Digest, Sha256};
    use std::io::{Cursor, Write};
    use std::sync::OnceLock;

    static PROFILE: OnceLock<Result<PortableProfile, String>> = OnceLock::new();
    PROFILE
        .get_or_init(|| {
            let exe = std::env::current_exe().map_err(|_| "실행 파일 경로를 찾을 수 없습니다.")?;
            let root = exe
                .parent()
                .ok_or("실행 파일 폴더를 찾을 수 없습니다.")?
                .join("BoaaData");
            let legacy_root = exe.parent().ok_or("실행 파일 폴더를 찾을 수 없습니다.")?.join("MoyaData");
            let legacy_lock = if legacy_root.is_dir() {
                let lock = std::fs::OpenOptions::new().read(true).write(true).create(true).truncate(false)
                    .open(legacy_root.join(".moya-running.lock")).map_err(|_| "BoaaData 폴더를 잠글 수 없습니다.")?;
                if lock.try_lock().is_err() { return Err("이 BoaaData 폴더를 사용하는 Boaa가 이미 실행 중입니다.".into()); }
                crate::brand_compat::migrate_directory(&legacy_root, &root).map_err(|_| "BoaaData 폴더에 쓸 수 없습니다. 쓰기 가능한 폴더에서 실행해 주세요.")?;
                Some(std::sync::Arc::new(lock))
            } else { None };
            std::fs::create_dir_all(&root)
                .map_err(|_| "BoaaData 폴더에 쓸 수 없습니다. 쓰기 가능한 폴더에서 실행해 주세요.")?;
            let lock = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(root.join(".boaa-running.lock"))
                .map_err(|_| "BoaaData 폴더를 잠글 수 없습니다.")?;
            if lock.try_lock().is_err() {
                if crate::portable_activation::activate_existing(&root) {
                    return Err("boaa_existing_focused".into());
                }
                return Err("이 BoaaData 폴더를 사용하는 Boaa가 이미 실행 중입니다.".into());
            }
            let payload = PORTABLE_PAYLOAD;
            let mut hasher = Sha256::new();
            hasher.update(payload);
            let digest = format!("{:x}", hasher.finalize());
            let runtime = root.join("runtime").join(&digest[..20]);
            let marker = runtime.join(".boaa-payload-sha256");
            let ready = || {
                std::fs::read_to_string(&marker).or_else(|_| std::fs::read_to_string(runtime.join(".moya-payload-sha256"))).ok().as_deref() == Some(digest.as_str())
                    && runtime.join("extension-sidecar/node.exe").is_file()
                    && runtime.join("extension-sidecar/native-entry.mjs").is_file()
                    && runtime
                        .join("collector-sidecar/webnovel-metadata-collector.exe")
                        .is_file()
            };
            if !ready() {
                if runtime.exists() {
                    return Err("포터블 실행 파일의 내부 리소스가 손상됐습니다. BoaaData/runtime의 해당 버전을 확인해 주세요.".into());
                }
                let runtime_parent = root.join("runtime");
                std::fs::create_dir_all(&runtime_parent)
                    .map_err(|_| "포터블 실행기 폴더를 만들 수 없습니다.")?;
                let nonce = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|_| "시스템 시각을 읽을 수 없습니다.")?
                    .as_nanos();
                let stage = runtime_parent.join(format!(".extract-{}-{nonce}", std::process::id()));
                std::fs::create_dir(&stage)
                    .map_err(|_| "포터블 실행기 임시 폴더를 만들 수 없습니다.")?;
                let extracted = (|| -> Result<(), String> {
                    let mut archive = zip::ZipArchive::new(Cursor::new(payload))
                        .map_err(|_| "포터블 실행 파일의 내부 압축 파일을 읽을 수 없습니다.")?;
                    if archive.len() > 20_000 {
                        return Err("포터블 실행기 파일 수가 허용 범위를 넘었습니다.".into());
                    }
                    let mut total: u64 = 0;
                    for index in 0..archive.len() {
                        let mut file = archive.by_index(index)
                            .map_err(|_| "포터블 실행기 파일을 읽을 수 없습니다.")?;
                        let relative = file.enclosed_name()
                            .ok_or("포터블 실행기 파일 경로가 올바르지 않습니다.")?;
                        if !relative.starts_with("extension-sidecar")
                            && !relative.starts_with("collector-sidecar")
                        {
                            return Err("포터블 실행기에 예상하지 못한 파일이 있습니다.".into());
                        }
                        total = total.saturating_add(file.size());
                        if total > 2 * 1024 * 1024 * 1024 {
                            return Err("포터블 실행기 크기가 허용 범위를 넘었습니다.".into());
                        }
                        let target = stage.join(relative);
                        if file.is_dir() {
                            std::fs::create_dir_all(&target)
                                .map_err(|_| "포터블 실행기 폴더를 만들 수 없습니다.")?;
                            continue;
                        }
                        std::fs::create_dir_all(target.parent().ok_or("잘못된 실행기 경로")?)
                            .map_err(|_| "포터블 실행기 폴더를 만들 수 없습니다.")?;
                        let mut output = std::fs::File::create(&target)
                            .map_err(|_| "포터블 실행기를 디스크에 쓸 수 없습니다.")?;
                        std::io::copy(&mut file, &mut output)
                            .map_err(|_| "포터블 실행기를 디스크에 쓸 수 없습니다.")?;
                        output.flush().map_err(|_| "포터블 실행기 파일 기록에 실패했습니다.")?;
                    }
                    if !stage.join("extension-sidecar/node.exe").is_file()
                        || !stage.join("extension-sidecar/native-entry.mjs").is_file()
                        || !stage.join("collector-sidecar/webnovel-metadata-collector.exe").is_file()
                    {
                        return Err("포터블 실행기에 필요한 파일이 빠졌습니다.".into());
                    }
                    std::fs::write(stage.join(".boaa-payload-sha256"), &digest)
                        .map_err(|_| "포터블 실행기 검증 정보를 기록할 수 없습니다.")?;
                    std::fs::rename(&stage, &runtime)
                        .map_err(|_| "포터블 실행기 설치를 완료할 수 없습니다.")?;
                    Ok(())
                })();
                if extracted.is_err() {
                    // Only this process's private staging directory is removed.
                    let _ = std::fs::remove_dir_all(&stage);
                }
                extracted?;
            }
            Ok(PortableProfile { root, runtime, _lock: std::sync::Arc::new(lock), _legacy_lock: legacy_lock })
        })
        .clone()
}

#[cfg(all(boaa_portable, target_os = "windows"))]
fn installed_webview2() -> bool {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY};
    use winreg::RegKey;

    const CLIENT: &str =
        r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    [
        (HKEY_CURRENT_USER, KEY_READ),
        (HKEY_CURRENT_USER, KEY_READ | KEY_WOW64_32KEY),
        (HKEY_LOCAL_MACHINE, KEY_READ),
        (HKEY_LOCAL_MACHINE, KEY_READ | KEY_WOW64_32KEY),
    ]
    .into_iter()
    .any(|(root, flags)| {
        RegKey::predef(root)
            .open_subkey_with_flags(CLIENT, flags)
            .ok()
            .and_then(|key| key.get_value::<String, _>("pv").ok())
            .is_some_and(|version| !version.is_empty() && version != "0.0.0.0")
    })
}

#[cfg(all(boaa_portable, target_os = "windows"))]
pub(crate) fn ensure_webview2() -> Result<(), String> {
    if installed_webview2() {
        Ok(())
    } else {
        Err("Microsoft Edge WebView2 Runtime이 필요합니다.\nhttps://developer.microsoft.com/microsoft-edge/webview2 에서 Evergreen Runtime을 설치한 뒤 Boaa.exe를 다시 실행해 주세요.".into())
    }
}

pub(crate) fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(boaa_portable)]
    {
        let _ = app;
        Ok(prepare()?.root.join("data"))
    }
    #[cfg(not(boaa_portable))]
    app.path()
        .app_data_dir()
        .map_err(|_| "native_storage_unavailable".into())
}

pub(crate) fn cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(boaa_portable)]
    {
        let _ = app;
        Ok(prepare()?.root.join("cache"))
    }
    #[cfg(not(boaa_portable))]
    app.path()
        .app_cache_dir()
        .map_err(|_| "native_cache_unavailable".into())
}

pub(crate) fn runtime_dir(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(boaa_portable)]
    {
        let _ = app;
        Ok(prepare()?.runtime)
    }
    #[cfg(not(boaa_portable))]
    app.path()
        .resource_dir()
        .map_err(|_| "native_resources_unavailable".into())
}

#[cfg(all(boaa_portable, target_os = "windows"))]
pub(crate) fn show_error(message: &str) {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(
            window: *mut std::ffi::c_void,
            text: *const u16,
            title: *const u16,
            kind: u32,
        ) -> i32;
    }
    let text: Vec<u16> = std::ffi::OsStr::new(message)
        .encode_wide()
        .chain(Some(0))
        .collect();
    let title: Vec<u16> = std::ffi::OsStr::new("Boaa")
        .encode_wide()
        .chain(Some(0))
        .collect();
    unsafe {
        MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), 0x10);
    }
}

// Only enabled by the isolated Windows candidate smoke. No normal-launch files or settings are changed.
#[tauri::command]
pub(crate) fn desktop_portable_smoke_ready(persisted: bool) -> Result<(), String> {
    #[cfg(boaa_portable)]
    {
        let token = crate::brand_compat::environment("BOAA_PORTABLE_SMOKE_TOKEN")
            .map_err(|_| "smoke_disabled")?;
        if token.len() != 32 || !token.bytes().all(|value| value.is_ascii_hexdigit()) {
            return Err("smoke_disabled".into());
        }
        let value = serde_json::json!({"pid": std::process::id(), "persisted": persisted});
        std::fs::write(
            prepare()?.root.join(format!(".smoke-{token}.json")),
            value.to_string(),
        )
        .map_err(|_| "smoke_write_failed".into())
    }
    #[cfg(not(boaa_portable))]
    {
        let _ = persisted;
        Err("smoke_disabled".into())
    }
}
