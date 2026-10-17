fn main() {
    println!("cargo:rustc-check-cfg=cfg(boaa_embedded_server)");
    println!("cargo:rerun-if-env-changed=BOAA_EMBEDDED_SERVER_BUILD");
    if std::env::var("BOAA_EMBEDDED_SERVER_BUILD")
        .or_else(|error| match error {
            std::env::VarError::NotPresent => std::env::var("MOYA_EMBEDDED_SERVER_BUILD"),
            _ => Err(error),
        })
        .as_deref()
        == Ok("1")
    {
        println!("cargo:rustc-cfg=boaa_embedded_server");
    }
    println!("cargo:rustc-check-cfg=cfg(boaa_portable)");
    println!("cargo:rerun-if-env-changed=BOAA_PORTABLE_BUILD");
    println!("cargo:rerun-if-changed=portable-payload.zip");
    if std::env::var("BOAA_PORTABLE_BUILD")
        .or_else(|error| match error {
            std::env::VarError::NotPresent => std::env::var("MOYA_PORTABLE_BUILD"),
            _ => Err(error),
        })
        .as_deref()
        == Ok("1")
    {
        let payload = std::path::Path::new("portable-payload.zip");
        if !payload.is_file() {
            panic!("portable payload missing; run the portable Windows build command");
        }
        let bytes = std::fs::read(payload).expect("cannot read portable payload");
        if bytes.len() < 1024 {
            panic!("portable payload is empty");
        }
        let output =
            std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR missing"));
        std::fs::write(output.join("portable-payload.zip"), bytes)
            .expect("cannot stage portable payload");
        println!("cargo:rustc-cfg=boaa_portable");
    }
    println!("cargo:rerun-if-env-changed=BOAA_GOOGLE_DESKTOP_CLIENT_ID");
    println!("cargo:rerun-if-env-changed=BOAA_GOOGLE_DESKTOP_CLIENT_SECRET");
    for key in [
        "MOYA_EMBEDDED_SERVER_BUILD",
        "MOYA_PORTABLE_BUILD",
        "MOYA_GOOGLE_DESKTOP_CLIENT_ID",
        "MOYA_GOOGLE_DESKTOP_CLIENT_SECRET",
    ] {
        println!("cargo:rerun-if-env-changed={key}");
    }
    tauri_build::build()
}
