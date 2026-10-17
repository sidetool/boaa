mod ai;
mod android_document_io;
#[cfg(target_os = "android")]
mod android_plugins;
mod app;
mod brand_compat;
#[cfg(not(target_os = "android"))]
mod credential_brand_compat;
mod desktop_oauth;
mod desktop_remote_window;
mod embedded_server;
mod extension_runtime;
mod google_oauth;
mod google_service_account;
mod metadata_collector;
mod native_identity;
mod portable;
#[cfg(boaa_portable)]
mod portable_activation;
mod portable_vault;
#[cfg(boaa_portable)]
mod portable_window;
mod provider_http;
mod provider_secrets;
mod secure_credentials;
mod tts;
mod workflow;

pub use app::run;
