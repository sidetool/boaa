import path from 'node:path';

export const PUBLIC_FORBIDDEN_PREFIXES = [
  '.boaa-lab/',
  'artifacts/',
  'handoff/',
  'smart-novel-reader-codex-pack/',
  'speaker-review-studio/',
  'test_novel/',
  'ui-reference/',
  'scripts/public-release-sync',
  'scripts/speaker-labeling-lab/',
  'scripts/speaker-pilot/',
  'scripts/apk-compat/',
  'docs/0722_review/',
  'docs/pro_review/',
  'docs/pro_review0713/',
  'docs/project/',
  'docs/refactoring/',
  'docs/archive/',
  'docs/design/',
  'docs/decisions/',
  'docs/extensions/evidence/',
  'docs/extensions/proposals/',
  'prototypes/ui-next/',
  'src-tauri/target/',
];

const privateDevelopmentFiles = new Set([
  'docs/boaa-migration.md',
  'docs/platforms/desktop-next-work.md',
  'docs/operations/reader-ux-verification.md',
  'docs/architecture/boaapatch-extension-packages.md',
  'docs/architecture/large-file-and-sync-architecture.md',
  'scripts/plugins/shell-document.mjs',
  'scripts/plugins/platform-shell-document.mjs',
  'services/webnovel-metadata-collector/docs/implementation-plan.md',
  'services/webnovel-metadata-collector/docs/adult-authentication.md',
  'services/webnovel-metadata-collector/docs/viewer-auth-integration.md',
]);

export const PUBLIC_FORBIDDEN_NAMES = new Set([
  '.env',
  'google-services.json',
  'id_ed25519',
  'id_rsa',
  'key.properties',
  'keystore.properties',
  'local.properties',
]);

export const PUBLIC_FORBIDDEN_EXTENSIONS = new Set([
  '.aab',
  '.apk',
  '.appimage',
  '.deb',
  '.dmg',
  '.exe',
  '.ipa',
  '.jks',
  '.key',
  '.keystore',
  '.mobileprovision',
  '.msi',
  '.msix',
  '.p12',
  '.pem',
  '.pfx',
  '.pkg',
  '.rpm',
]);

export const PUBLIC_REQUIRED_PRODUCT_SOURCES = [
  'compose.metadata-collector.yaml',
  'compose.metadata-collector-auth.yaml',
  'deploy/metadata-collector.Dockerfile',
  'deploy/metadata-collector-auth.Dockerfile',
  'assets/branding/boaa-app-icon.png',
  'assets/branding/boaa-wordmark.png',
  'assets/branding/README.md',
  'public/manifest.webmanifest',
  'public/sw.js',
  'public/branding/boaa-wordmark.png',
  'public/icons/boaa-32.png',
  'public/icons/boaa-192.png',
  'public/icons/boaa-512.png',
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
  'src-tauri/tauri.conf.json',
  'src-tauri/src/app.rs',
  'src-tauri/src/android_document_io.rs',
  'src-tauri/src/android_plugins.rs',
  'src-tauri/src/provider_secrets.rs',
  'src-tauri/src/secure_credentials.rs',
  'src-tauri/src/ai/bridge.rs',
  'src-tauri/src/tts/bridge.rs',
  'src-tauri/src/tts/render_cache.rs',
  'src-tauri/src/workflow/bridge.rs',
  'src-tauri/mobile/android/AppCredentialStorePlugin.kt',
  'src-tauri/mobile/android/DocumentIoPlugin.kt',
  'src-tauri/mobile/android/NativeTtsRecoveryWorker.kt.template',
  'src-tauri/mobile/android/BoaaPlaybackService.kt.template',
  'src-tauri/mobile/android/ProviderSecretStorePlugin.kt',
  'src-tauri/mobile/android/SystemTtsPlugin.kt.template',
  'src-tauri/gen/android/gradlew',
  'src-tauri/gen/android/app/build.gradle.kts',
  'src-tauri/gen/android/gradle/wrapper/gradle-wrapper.jar',
  'src-tauri/gen/android/app/src/main/AndroidManifest.xml',
  'scripts/build-android-arm64-debug.mjs',
  'scripts/build-webnovel-metadata-collector-sidecar.mjs',
  'scripts/generate-brand-assets.mjs',
  'scripts/generate-webnovel-metadata-collector-license-inventory.py',
  'scripts/public-release-boundary.mjs',
  'scripts/plugins/build-product-runtime.mjs',
  'scripts/sync-tauri-android-document-io-plugin.mjs',
  'scripts/sync-tauri-android-provider-secret-plugin.mjs',
  'scripts/verify-mobile-readiness.mjs',
  'services/webnovel-metadata-collector/pyproject.toml',
  'services/webnovel-metadata-collector/app/sidecar.py',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
];

export function normalizePublicPath(file) {
  return file.replaceAll('\\', '/').replace(/^\.\//, '');
}

export function isForbiddenPublicPath(file) {
  const normalized = normalizePublicPath(file);
  const lower = normalized.toLowerCase();
  const base = path.posix.basename(lower);
  const extension = path.posix.extname(lower);

  return (
    PUBLIC_FORBIDDEN_PREFIXES.some((prefix) => lower.startsWith(prefix.toLowerCase())) ||
    privateDevelopmentFiles.has(lower) ||
    /^docs\/operations\/2026-[^/]*$/.test(lower) ||
    /^docs\/extensions\/(?:javascript-plugin-.*(?:results|implementation-review|platform-plan)|(?:implementation-audit|implementation-review|platform-plan|platform-review|public-extension-roadmap|mangayomi-corpus).*)\.md$/.test(
      lower,
    ) ||
    /^scripts\/plugins\/[gp]\d[^/]*\//.test(lower) ||
    /^apps\/server\/src\/extensions\/mangayomi\/fixtures\/upstream\/.*\.js\.txt$/.test(lower) ||
    PUBLIC_FORBIDDEN_NAMES.has(base) ||
    PUBLIC_FORBIDDEN_EXTENSIONS.has(extension) ||
    (base.startsWith('.env.') && base !== '.env.example') ||
    /(^|\/)(credentials[^/]*|[^/]*service-account[^/]*)\.json$/i.test(normalized) ||
    /^scripts\/test-novel-.*\.ts$/i.test(normalized) ||
    (lower.startsWith('secrets/') && lower !== 'secrets/vertex/.gitkeep')
  );
}

export function validatePublicFileList(files, requiredFiles = PUBLIC_REQUIRED_PRODUCT_SOURCES) {
  const normalized = files.map(normalizePublicPath);
  const fileSet = new Set(normalized);
  return {
    violations: normalized.filter(isForbiddenPublicPath),
    missing: requiredFiles.map(normalizePublicPath).filter((file) => !fileSet.has(file)),
  };
}
