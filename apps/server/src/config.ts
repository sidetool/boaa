import path from 'node:path';

export type ServerExposure = 'loopback' | 'external';

export interface ProviderJobAdmissionLimits {
  /** Maximum queued/running attempts. Zero explicitly disables this limit. */
  maxActiveAttempts: number;
  /** Maximum admitted attempts in a rolling 60-second window. Zero disables this limit. */
  maxAttemptsPerMinute: number;
  /** Maximum admitted attempts during one UTC calendar day. Zero disables this limit. */
  maxAttemptsPerUtcDay: number;
}

export const DEFAULT_PROVIDER_JOB_ADMISSION_LIMITS: Readonly<ProviderJobAdmissionLimits> = Object.freeze({
  maxActiveAttempts: 4,
  maxAttemptsPerMinute: 60,
  maxAttemptsPerUtcDay: 1_000,
});

const defaultLocalCorsOrigins = [
  'http://127.0.0.1:1421',
  'http://localhost:1421',
  'http://127.0.0.1:8080',
  'http://localhost:8080',
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
] as const;

export interface ServerConfig {
  host: string;
  port: number;
  databaseUrl: string;
  legacyDatabaseUrl?: string;
  redisUrl: string;
  dataDir: string;
  /** App-owned object directory. Unset keeps the existing S3 deployment. */
  objectStorageDir?: string;
  /** Bundled shared reader assets; omitted for existing reverse-proxy deployments. */
  webRoot?: string;
  /** Explicit browser origin for the opt-in JS plugin runtime. Never inferred from request headers. */
  pluginOrigin?: string;
  /** JSON list of exact administrator-approved RFC1918 backend origins. */
  pluginPrivateOrigins?: string;
  /** Filesystem containing the actual object store; empty disables capacity probing. */
  storageCapacityPath?: string;
  storageMinimumFreeBytes?: number;
  maxChunkBytes: number;
  maxUploadBytes: number;
  maxArchiveUploadBytes?: number;
  staleUploadMaxAgeMs: number;
  runMigrationsOnStart: boolean;
  defaultUserId: string;
  providerJobAdmission?: ProviderJobAdmissionLimits;
  authToken?: string;
  /** Number of immediate reverse-proxy hops allowed to supply X-Forwarded-For. Zero disables trust. */
  trustedProxyHops?: number;
  exposure?: ServerExposure;
  corsAllowedOrigins?: readonly string[];
  webNovelMetadataCollectorUrl?: string;
  webNovelMetadataCollectorSessionToken?: string;
  webNovelMetadataCollectorRemoteAuthEnabled?: boolean;
  textSourceServerUrl?: string;
  textSourceServerKey?: string;
  /** Operator-owned HTTP(S)/SOCKS5 egress used only by installed SDK source requests. */
  sourceOutboundProxy?: string;
  s3: {
    endpoint: string;
    region: string;
    bucket: string;
    legacyBucket?: string;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle: boolean;
  };
}

export function pluginOriginFromEnv(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const origin = value.trim();
  const url = new URL(origin);
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    !(
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    )
  )
    throw new Error('JS_PLUGIN_ORIGIN must be an exact HTTPS origin (HTTP loopback is allowed for development)');
  return origin;
}

function optionalInternalHttpUrlFromEnv(value: string | undefined, key: string): string | undefined {
  const candidate = value?.trim();
  if (!candidate) return undefined;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(`${key} must be an HTTP(S) URL`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${key} must be an HTTP(S) URL without credentials, query strings, or fragments`);
  }
  url.pathname = url.pathname.replace(/\/+$/u, '') || '/';
  return url.toString().replace(/\/$/u, '');
}

function optionalOutboundProxyFromEnv(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  if (!candidate) return undefined;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error('SOURCE_OUTBOUND_PROXY must be an HTTP(S) or SOCKS5 proxy URL');
  }
  if (
    !['http:', 'https:', 'socks5:'].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    (url.pathname !== '/' && url.pathname !== '') ||
    url.search ||
    url.hash
  )
    throw new Error('SOURCE_OUTBOUND_PROXY must not contain credentials, a path, query, or fragment');
  return url.href;
}

function boolFromEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function nonNegativeIntegerFromEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${key} must be a non-negative integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${key} must be a safe non-negative integer`);
  return parsed;
}

function positiveIntegerFromEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const parsed = nonNegativeIntegerFromEnv(env, key, fallback);
  if (parsed <= 0 || parsed > maximum) {
    throw new Error(`${key} must be a positive integer no greater than ${maximum}`);
  }
  return parsed;
}

function boundedNonNegativeIntegerFromEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  maximum: number,
): number {
  const parsed = nonNegativeIntegerFromEnv(env, key, fallback);
  if (parsed > maximum) throw new Error(`${key} must be no greater than ${maximum}`);
  return parsed;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (normalized === 'localhost' || normalized === '::1') return true;
  const octets = normalized.split('.').map((part) => Number(part));
  return (
    octets.length === 4 &&
    octets[0] === 127 &&
    octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
  );
}

function exposureFromEnv(env: NodeJS.ProcessEnv, host: string): ServerExposure {
  const configured = env.SERVER_EXPOSURE?.trim().toLowerCase();
  if (configured !== undefined && configured !== 'loopback' && configured !== 'external') {
    throw new Error('SERVER_EXPOSURE must be either loopback or external');
  }
  if (configured) return configured;
  if (env.NODE_ENV?.trim().toLowerCase() === 'production') return 'external';
  return isLoopbackHost(host) ? 'loopback' : 'external';
}

function normalizeCorsOrigin(value: string): string {
  const candidate = value.trim();
  if (!candidate || candidate === '*' || candidate.toLowerCase() === 'null') {
    throw new Error('CORS_ALLOWED_ORIGINS must contain explicit web origins and must not use * or null');
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error('CORS_ALLOWED_ORIGINS must contain valid origins');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'tauri:') ||
    url.username ||
    url.password ||
    (url.pathname !== '' && url.pathname !== '/') ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'CORS_ALLOWED_ORIGINS must contain origins without credentials, paths, query strings, or fragments',
    );
  }
  return url.origin === 'null' ? `${url.protocol}//${url.host}` : url.origin;
}

function corsOriginsFromEnv(env: NodeJS.ProcessEnv): readonly string[] {
  const configured = env.CORS_ALLOWED_ORIGINS ?? env.CORS_ORIGIN;
  if (configured === undefined) return defaultLocalCorsOrigins;
  const origins = configured.split(',').map(normalizeCorsOrigin);
  return [...new Set(origins)];
}

function databaseUrlFromEnv(env: NodeJS.ProcessEnv, defaults = 'boaa'): string {
  const explicit = env.DATABASE_URL?.trim();
  if (explicit) return explicit;
  const hasPgFields = ['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE'].some((key) => env[key] !== undefined);
  if (!hasPgFields) return `postgres://${defaults}:${defaults}@127.0.0.1:5432/${defaults}`;
  const port = positiveIntegerFromEnv(env, 'PGPORT', 5432, 65_535);
  const url = new URL('postgres://localhost');
  url.hostname = env.PGHOST?.trim() || '127.0.0.1';
  url.port = String(port);
  url.username = env.PGUSER ?? defaults;
  url.password = env.PGPASSWORD ?? defaults;
  url.pathname = `/${encodeURIComponent(env.PGDATABASE ?? defaults)}`;
  return url.toString();
}

function legacyDatabaseUrlFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  if (env.DATABASE_URL?.trim()) return undefined;
  const explicit = env.BOAA_LEGACY_DATABASE_URL;
  if (explicit !== undefined && explicit !== 'auto') return explicit || undefined;
  if (explicit !== 'auto' && ['PGUSER', 'PGPASSWORD', 'PGDATABASE'].every((key) => env[key] !== undefined))
    return undefined;
  return databaseUrlFromEnv(
    {
      ...env,
      PGUSER: env.BOAA_LEGACY_PGUSER ?? env.PGUSER,
      PGPASSWORD: env.BOAA_LEGACY_PGPASSWORD ?? env.PGPASSWORD,
      PGDATABASE: env.BOAA_LEGACY_PGDATABASE ?? env.PGDATABASE,
    },
    'noveldesk',
  );
}

export function serverExposure(config: ServerConfig): ServerExposure {
  return config.exposure ?? (isLoopbackHost(config.host) ? 'loopback' : 'external');
}

export function corsAllowedOrigins(config: ServerConfig): readonly string[] {
  const origins = config.corsAllowedOrigins ?? defaultLocalCorsOrigins;
  return [...new Set(origins.map(normalizeCorsOrigin))];
}

export function providerJobAdmissionLimits(config: ServerConfig): ProviderJobAdmissionLimits {
  return { ...(config.providerJobAdmission ?? DEFAULT_PROVIDER_JOB_ADMISSION_LIMITS) };
}

export function assertSecureServerConfig(config: ServerConfig): void {
  corsAllowedOrigins(config);
  if (serverExposure(config) === 'external' && !config.authToken?.trim()) {
    throw new Error('READER_AUTH_TOKEN is required when SERVER_EXPOSURE is external');
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const host = env.HOST ?? '127.0.0.1';
  return {
    host,
    port: positiveIntegerFromEnv(env, 'PORT', 8787, 65_535),
    databaseUrl: databaseUrlFromEnv(env),
    legacyDatabaseUrl: legacyDatabaseUrlFromEnv(env),
    redisUrl: env.REDIS_URL ?? 'redis://127.0.0.1:6379',
    dataDir: path.resolve(env.SERVER_DATA_DIR ?? '.server-data'),
    objectStorageDir: env.OBJECT_STORAGE_DIR?.trim() ? path.resolve(env.OBJECT_STORAGE_DIR) : undefined,
    pluginOrigin: pluginOriginFromEnv(env.JS_PLUGIN_ORIGIN),
    pluginPrivateOrigins: env.JS_PLUGIN_PRIVATE_ORIGINS,
    webRoot: env.SERVER_WEB_ROOT?.trim() ? path.resolve(env.SERVER_WEB_ROOT) : undefined,
    storageCapacityPath:
      env.STORAGE_CAPACITY_PATH === undefined || env.STORAGE_CAPACITY_PATH === 'auto'
        ? undefined
        : env.STORAGE_CAPACITY_PATH.trim()
          ? path.resolve(env.STORAGE_CAPACITY_PATH)
          : '',
    storageMinimumFreeBytes: nonNegativeIntegerFromEnv(env, 'STORAGE_MIN_FREE_BYTES', 256 * 1024 ** 2),
    maxChunkBytes: positiveIntegerFromEnv(env, 'MAX_CHUNK_BYTES', 16 * 1024 * 1024),
    maxUploadBytes: positiveIntegerFromEnv(env, 'MAX_UPLOAD_BYTES', 500 * 1024 * 1024),
    maxArchiveUploadBytes: positiveIntegerFromEnv(env, 'MAX_ARCHIVE_UPLOAD_BYTES', 4 * 1024 ** 3),
    staleUploadMaxAgeMs: nonNegativeIntegerFromEnv(env, 'STALE_UPLOAD_MAX_AGE_MS', 7 * 24 * 60 * 60 * 1000),
    runMigrationsOnStart: boolFromEnv(env.RUN_MIGRATIONS_ON_START, true),
    defaultUserId: env.DEFAULT_USER_ID ?? 'user_dev',
    providerJobAdmission: {
      maxActiveAttempts: nonNegativeIntegerFromEnv(
        env,
        'PROVIDER_MAX_ACTIVE_ATTEMPTS',
        DEFAULT_PROVIDER_JOB_ADMISSION_LIMITS.maxActiveAttempts,
      ),
      maxAttemptsPerMinute: nonNegativeIntegerFromEnv(
        env,
        'PROVIDER_MAX_ATTEMPTS_PER_MINUTE',
        DEFAULT_PROVIDER_JOB_ADMISSION_LIMITS.maxAttemptsPerMinute,
      ),
      maxAttemptsPerUtcDay: nonNegativeIntegerFromEnv(
        env,
        'PROVIDER_MAX_ATTEMPTS_PER_UTC_DAY',
        DEFAULT_PROVIDER_JOB_ADMISSION_LIMITS.maxAttemptsPerUtcDay,
      ),
    },
    authToken: env.READER_AUTH_TOKEN?.trim() || env.API_AUTH_TOKEN?.trim() || undefined,
    trustedProxyHops: boundedNonNegativeIntegerFromEnv(env, 'TRUSTED_PROXY_HOPS', 0, 4),
    exposure: exposureFromEnv(env, host),
    corsAllowedOrigins: corsOriginsFromEnv(env),
    textSourceServerUrl: optionalInternalHttpUrlFromEnv(env.TEXT_SOURCE_SERVER_URL, 'TEXT_SOURCE_SERVER_URL'),
    textSourceServerKey: env.TEXT_SOURCE_SERVER_KEY?.trim() || undefined,
    sourceOutboundProxy: optionalOutboundProxyFromEnv(env.SOURCE_OUTBOUND_PROXY),
    webNovelMetadataCollectorUrl: optionalInternalHttpUrlFromEnv(
      env.WEBNOVEL_METADATA_COLLECTOR_URL,
      'WEBNOVEL_METADATA_COLLECTOR_URL',
    ),
    webNovelMetadataCollectorSessionToken: env.WEBNOVEL_METADATA_COLLECTOR_SESSION_TOKEN?.trim() || undefined,
    webNovelMetadataCollectorRemoteAuthEnabled: boolFromEnv(env.WEBNOVEL_METADATA_COLLECTOR_REMOTE_AUTH_ENABLED, false),
    s3: {
      endpoint: env.S3_ENDPOINT ?? 'http://127.0.0.1:9000',
      region: env.S3_REGION ?? 'us-east-1',
      bucket: env.S3_BUCKET ?? 'boaa-uploads',
      legacyBucket:
        (env.BOAA_LEGACY_S3_BUCKET ?? (env.S3_BUCKET === undefined ? 'noveldesk-uploads' : undefined)) || undefined,
      accessKeyId: env.S3_ACCESS_KEY_ID ?? 'minio',
      secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? 'minio-password',
      forcePathStyle: boolFromEnv(env.S3_FORCE_PATH_STYLE, true),
    },
  };
}
