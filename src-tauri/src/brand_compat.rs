//! Compatibility with pre-BOAA profiles. Original directories are retained.
use std::path::{Path, PathBuf};

pub(crate) const LEGACY_APP_IDS: &[&str] = &["com.local.noveldeskreader", "com.local.moyareader"];
pub(crate) const APP_ID: &str = "com.sidetool.boaa";

pub(crate) fn environment(key: &str) -> Result<String, std::env::VarError> {
    match std::env::var(key) {
        Err(std::env::VarError::NotPresent) => {
            let suffix = key.strip_prefix("BOAA_").unwrap_or(key);
            for prefix in ["MOYA_", "NOVELDESK_", "MOA_"] {
                match std::env::var(format!("{prefix}{suffix}")) {
                    Err(std::env::VarError::NotPresent) => continue,
                    value => return value,
                }
            }
            Err(std::env::VarError::NotPresent)
        }
        value => value,
    }
}

fn copy_tree(source: &Path, target: &Path) -> std::io::Result<()> {
    std::fs::create_dir(target)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(target, std::fs::Permissions::from_mode(0o700))?;
    }
    for item in std::fs::read_dir(source)? {
        let item = item?;
        let kind = item.file_type()?;
        if [
            ".moya-running.lock",
            ".boaa-running.lock",
            "activation.json",
        ]
        .contains(&item.file_name().to_string_lossy().as_ref())
        {
            continue;
        }
        if kind.is_symlink() {
            // Browser singleton links/sockets are ephemeral and must never be copied.
            continue;
        }
        let destination = target.join(item.file_name());
        if kind.is_dir() {
            copy_tree(&item.path(), &destination)?;
        } else if kind.is_file() {
            std::fs::copy(item.path(), destination)?;
        }
    }
    Ok(())
}

/// Publishes a complete snapshot by rename; an existing canonical profile is authoritative.
pub(crate) fn migrate_directory(source: &Path, target: &Path) -> std::io::Result<bool> {
    if target.exists() || !source.is_dir() || source == target {
        return Ok(false);
    }
    let parent = target
        .parent()
        .ok_or_else(|| std::io::Error::other("profile parent missing"))?;
    std::fs::create_dir_all(parent)?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let stage = parent.join(format!(".boaa-migrate-{}-{stamp}", std::process::id()));
    let result = (|| {
        copy_tree(source, &stage)?;
        if target.exists() {
            return Ok(false);
        }
        std::fs::rename(&stage, target)?;
        Ok(true)
    })();
    if stage.exists() {
        let _ = std::fs::remove_dir_all(&stage);
    }
    result
}

fn profile_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    #[cfg(target_os = "linux")]
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        for (key, suffix) in [
            ("XDG_DATA_HOME", ".local/share"),
            ("XDG_CONFIG_HOME", ".config"),
            ("XDG_CACHE_HOME", ".cache"),
        ] {
            roots.push(
                std::env::var_os(key)
                    .map(PathBuf::from)
                    .unwrap_or_else(|| home.join(suffix)),
            );
        }
    }
    #[cfg(target_os = "windows")]
    for key in ["APPDATA", "LOCALAPPDATA"] {
        if let Some(root) = std::env::var_os(key) {
            roots.push(PathBuf::from(root));
        }
    }
    #[cfg(target_os = "macos")]
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        for suffix in [
            "Library/Application Support",
            "Library/Caches",
            "Library/WebKit",
            "Library/HTTPStorages",
        ] {
            roots.push(home.join(suffix));
        }
    }
    roots
}

pub(crate) fn migrate_profiles(app_id: &str) -> std::io::Result<()> {
    let legacy_ids: &[&str] = match app_id {
        APP_ID => LEGACY_APP_IDS,
        "app.boaa.reader.embedded-candidate" => &["app.moya.reader.embedded-candidate"],
        "app.boaa.reader" => &["app.moya.reader"],
        _ => return Ok(()), // The legacy-ID export build continues opening its own existing sandbox.
    };
    let roots = profile_roots();
    if let Ok(source) = environment("BOAA_LEGACY_APP_DATA_DIR") {
        if let Some(root) = roots.first() {
            migrate_directory(Path::new(&source), &root.join(app_id))?;
        }
    }
    for root in roots {
        for id in legacy_ids {
            migrate_directory(&root.join(id), &root.join(app_id))?;
        }
    }
    Ok(())
}

pub(crate) fn credential_aliases(service: &str, account: &str) -> Vec<(String, String)> {
    let services: &[&str] = match service {
        "Boaa App Credentials" => &["Moya App Credentials", "NovelDesk App Credentials"],
        "Boaa Reader Provider Secrets" => &[
            "NovelDesk Reader Provider Secrets",
            "Moya Reader Provider Secrets",
        ],
        _ => &[],
    };
    let mut accounts = vec![account.to_owned()];
    if let Some(suffix) = account.strip_prefix("boaa:") {
        accounts.extend(["noveldesk:", "moya:"].map(|prefix| format!("{prefix}{suffix}")));
    }
    let mut result = Vec::new();
    for old_service in std::iter::once(&service).chain(services.iter()) {
        for old_account in &accounts {
            if *old_service != service || old_account != account {
                result.push((old_service.to_string(), old_account.clone()));
            }
        }
    }
    result
}

pub(crate) fn read_credential<T, E>(
    service: &str,
    account: &str,
    mut read: impl FnMut(&str, &str) -> Result<T, E>,
    mut write: impl FnMut(&str, &str, &T) -> Result<(), E>,
    missing: impl Fn(&E) -> bool,
) -> Result<T, E> {
    match read(service, account) {
        Ok(value) => Ok(value),
        Err(error) if missing(&error) => {
            for (old_service, old_account) in credential_aliases(service, account) {
                match read(&old_service, &old_account) {
                    Ok(value) => {
                        let _ = write(service, account, &value);
                        return Ok(value);
                    }
                    Err(error) if missing(&error) => continue,
                    Err(error) => return Err(error),
                }
            }
            Err(error)
        }
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    #[test]
    fn new_environment_values_including_empty_override_legacy_names() {
        let current = "BOAA_MIGRATION_ENV_COMPAT_TEST";
        let previous = "MOYA_MIGRATION_ENV_COMPAT_TEST";
        std::env::remove_var(current);
        std::env::set_var(previous, "legacy");
        assert_eq!(environment(current).unwrap(), "legacy");
        std::env::set_var(current, "");
        assert_eq!(environment(current).unwrap(), "");
        std::env::remove_var(current);
        std::env::remove_var(previous);
    }

    #[test]
    fn copies_profile_atomically_once_without_removing_original() {
        let root = std::env::temp_dir().join(format!("boaa-migration-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let old = root.join("old");
        let new = root.join("new");
        std::fs::create_dir_all(old.join("WebView/IndexedDB")).unwrap();
        std::fs::write(
            old.join("WebView/IndexedDB/data"),
            b"original authentication and library bytes",
        )
        .unwrap();
        assert!(migrate_directory(&old, &new).unwrap());
        assert_eq!(
            std::fs::read(new.join("WebView/IndexedDB/data")).unwrap(),
            std::fs::read(old.join("WebView/IndexedDB/data")).unwrap()
        );
        std::fs::write(new.join("WebView/IndexedDB/data"), b"canonical wins").unwrap();
        assert!(!migrate_directory(&old, &new).unwrap());
        assert_eq!(
            std::fs::read(new.join("WebView/IndexedDB/data")).unwrap(),
            b"canonical wins"
        );
        assert!(old.exists());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn migrates_legacy_credentials_and_preserves_new_and_read_only_values() {
        let rows = RefCell::new(HashMap::from([(
            (
                "Moya App Credentials".to_owned(),
                "noveldesk:server_api_token".to_owned(),
            ),
            "legacy".to_owned(),
        )]));
        let read = |service: &str, account: &str| {
            rows.borrow()
                .get(&(service.into(), account.into()))
                .cloned()
                .ok_or("missing")
        };
        let value = read_credential(
            "Boaa App Credentials",
            "boaa:server_api_token",
            read,
            |service, account, value| {
                rows.borrow_mut()
                    .insert((service.into(), account.into()), value.clone());
                Ok(())
            },
            |error| *error == "missing",
        )
        .unwrap();
        assert_eq!(value, "legacy");
        rows.borrow_mut().insert(
            (
                "Boaa App Credentials".into(),
                "boaa:server_api_token".into(),
            ),
            "canonical".into(),
        );
        assert_eq!(
            read_credential(
                "Boaa App Credentials",
                "boaa:server_api_token",
                read,
                |_, _, _| Err("read only"),
                |e| *e == "missing"
            )
            .unwrap(),
            "canonical"
        );
        rows.borrow_mut().remove(&(
            "Boaa App Credentials".into(),
            "boaa:server_api_token".into(),
        ));
        assert_eq!(
            read_credential(
                "Boaa App Credentials",
                "boaa:server_api_token",
                read,
                |_, _, _| Err("read only"),
                |e| *e == "missing"
            )
            .unwrap(),
            "legacy"
        );
        assert!(read_credential(
            "Boaa App Credentials",
            "boaa:server_api_token",
            |_, _| Err::<String, _>("permission"),
            |_, _, _| Ok(()),
            |e| *e == "missing"
        )
        .is_err());
    }
}
