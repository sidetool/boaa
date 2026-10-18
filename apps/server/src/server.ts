import { ApkProcessBudget } from '../../../services/apk-worker/process-budget.mjs';
import { registerServerManagement } from './management/server-management.js';
import { createManagedMetadataFetch } from './extensions/runtime-component-client.js';
import { createByeDpiProcess } from './extensions/byedpi-process.js';
import { registerPluginRuntimeRoutes } from './routes/plugin-runtime.js';
import Fastify, { FastifyInstance, type FastifyError, type FastifyRequest, type FastifyReply } from 'fastify';
import { assertSecureServerConfig, corsAllowedOrigins, type ServerConfig } from './config.js';
import { createPool, seedDefaultUser } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { createImportQueue, createProviderQueue } from './queue.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerWebAssets } from './routes/web-assets.js';
import { registerUploadRoutes } from './routes/uploads.js';
import { stageServerImport } from './services/stage-server-import.js';
import { createDocumentSeriesSnapshot } from './services/document-series-snapshot.js';
import { createS3Client as createDocumentS3Client } from './services/object-storage.js';
import { registerBookRoutes } from './routes/books.js';
import { registerAIRoutes } from './routes/ai.js';
import { registerSyncRoutes } from './routes/sync.js';
import { registerBackupRoutes } from './routes/backups.js';
import { registerAdminAccountRoutes } from './routes/admin-accounts.js';
import { registerAdminSourceRoutes } from './routes/admin-sources.js';
import { accountIdentity } from './plugins/plugin-scope.js';
import { requestOwnerConfig } from './services/owner-context.js';
import { OwnerRuntimeRegistry } from './extensions/owner-runtime-registry.js';
import { bindOwnerRuntimeSignal } from './extensions/owner-runtime-request.js';
import { registerSelfHostAuthRoutes } from './routes/auth.js';
import { registerWebNovelMetadataCollectorGateway } from './routes/webnovel-metadata-collector-gateway.js';
import { registerTextSourceGateway } from './routes/text-source-gateway.js';
import {
  registerExtensionPackageRoutes,
  createExtensionRuntime,
  type ExtensionRuntime,
} from './routes/extension-packages.js';
import { PostgresPackageInstallStore } from './extensions/postgres-package-store.js';
import { createNodePackageExecution } from './extensions/node-package-execution.js';
import { createConfiguredContentService } from './extensions/configured-content-service.js';
import { parseInstalledTextMigration, createInstalledTextGateway } from './extensions/installed-text-gateway.js';
import { EncryptedSourceCredentialVault } from './extensions/source-credential-vault.js';
import { createSourceNetworkSettings } from './extensions/source-network-settings.js';
import { registerSourceNetworkSettingsRoutes } from './routes/source-network-settings.js';
import { loadProviderSecretMasterKey } from './providers/server-provider-secrets.js';
import { createHash, createHmac } from 'node:crypto';
import { access } from 'node:fs/promises';
import { ApkExtensionHost, apkOwnerDirectory } from './extensions/apk-extension-host.js';
import { registerApkExtensionRoutes } from './routes/apk-extensions.js';
import { MangayomiExtensionHost } from './extensions/mangayomi/host.js';
import path from 'node:path';
import { pruneStaleUploadSessions } from './services/upload-cleanup.js';
import { registerAuthHook, requireUserId } from './auth.js';
import { PostgresSelfHostAuthStore, SelfHostAuthService } from './services/self-host-auth-service.js';
import { createS3Client, ensureBucket } from './services/object-storage.js';
import {
  createStructuredLogger,
  metricsFromQueue,
  registerMetricsRoute,
  registerRequestObservability,
} from './observability/index.js';

const corsMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
const uploadPruneIntervalMs = 6 * 60 * 60 * 1000;
const corsHeaders = [
  'content-type',
  'authorization',
  'x-boaa-session-context',
  'x-request-id',
  'x-correlation-id',
  'x-backup-default-resolution',
  'x-backup-conflict-resolutions',
  'x-source-file-name',
  'x-source-content-type',
  'range',
  'if-range',
  'x-expected-metadata-revision',
  'x-cover-file-name',
  'x-cover-content-type',
  'x-cover-content-hash',
  'x-cover-width',
  'x-cover-height',
  'x-cover-fit',
  'x-cover-position-x',
  'x-cover-position-y',
  'x-cover-provenance',
  'x-font-content-type',
  'x-font-content-hash',
  'x-font-family',
  'x-font-file-name',
  'x-font-style',
  'x-font-weight',
  'x-font-license-note',
] as const;

function requestedCorsHeaders(value: string | string[] | undefined): string[] {
  const header = Array.isArray(value) ? value.join(',') : value;
  return header
    ? header
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean)
    : [];
}

function preflightAllowed(requestedMethod: string | undefined, requestedHeaders: readonly string[]): boolean {
  const methodAllowed =
    !requestedMethod || corsMethods.includes(requestedMethod.trim().toUpperCase() as (typeof corsMethods)[number]);
  return (
    methodAllowed && requestedHeaders.every((header) => corsHeaders.includes(header as (typeof corsHeaders)[number]))
  );
}

function sameOriginHost(origin: string, host: string | undefined): boolean {
  if (!host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.trim().toLowerCase();
  } catch {
    return false;
  }
}

export function registerCorsPolicy(app: FastifyInstance, config: ServerConfig): void {
  const allowedOrigins = new Set(corsAllowedOrigins(config));

  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (!origin) return;

    reply.header('Vary', 'Origin');
    // Same-origin browser traffic is not CORS and must keep working when the
    // self-host is reached through a private DNS name or reverse proxy. Exact
    // allowlisting remains mandatory for genuinely cross-origin clients.
    if (!allowedOrigins.has(origin) && !sameOriginHost(origin, request.headers.host)) {
      return reply.code(403).send({ error: 'cors_origin_denied' });
    }

    const requestedHeaders = requestedCorsHeaders(request.headers['access-control-request-headers']);
    if (
      request.method.toUpperCase() === 'OPTIONS' &&
      !preflightAllowed(request.headers['access-control-request-method'], requestedHeaders)
    ) {
      return reply.code(403).send({ error: 'cors_preflight_denied' });
    }

    reply.header('Access-Control-Allow-Origin', origin);
    reply.header('Access-Control-Allow-Methods', corsMethods.join(','));
    reply.header(
      'Access-Control-Allow-Headers',
      'Content-Type,Authorization,X-BOAA-Session-Context,Range,If-Range,X-Request-Id,X-Correlation-Id,X-Backup-Default-Resolution,X-Backup-Conflict-Resolutions,X-Source-File-Name,X-Source-Content-Type,X-Expected-Metadata-Revision,X-Cover-File-Name,X-Cover-Content-Type,X-Cover-Content-Hash,X-Cover-Width,X-Cover-Height,X-Cover-Fit,X-Cover-Position-X,X-Cover-Position-Y,X-Cover-Provenance,X-Font-Content-Type,X-Font-Content-Hash,X-Font-Family,X-Font-File-Name,X-Font-Style,X-Font-Weight,X-Font-License-Note',
    );
    reply.header(
      'Access-Control-Expose-Headers',
      'X-Request-Id,X-Correlation-Id,X-Asset-Id,X-Asset-Kind,X-Asset-Provenance,X-Asset-Status,X-Asset-File-Name,X-Asset-Content-Hash,X-Asset-Pixel-Width,X-Asset-Pixel-Height,X-Asset-Created-At,X-Asset-Activated-At,X-Page-Index,X-Source-File-Name,X-Source-Content-Hash,Accept-Ranges,Content-Range,Content-Length,Content-Disposition,ETag',
    );
    reply.header('Access-Control-Max-Age', '600');
  });

  app.options('/*', async (_request, reply) => reply.code(204).send());
}

export function registerSafeErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    const statusCode = Number.isInteger(error.statusCode) ? Number(error.statusCode) : 500;
    if (statusCode < 500) {
      return reply.code(statusCode).send({
        error: error.message,
        ...(typeof error.code === 'string' ? { code: error.code } : undefined),
      });
    }
    const requestId = reply.getHeader('x-request-id');
    return reply.code(500).send({
      error: '서버 요청을 처리하지 못했습니다.',
      code: 'internal_server_error',
      ...(typeof requestId === 'string' && requestId ? { requestId } : undefined),
    });
  });
}

export async function buildServer(
  config: ServerConfig,
  options: { readonly membersReady?: boolean } = {},
): Promise<FastifyInstance> {
  assertSecureServerConfig(config);

  if (config.runMigrationsOnStart) {
    await runMigrations();
  }

  const pool = createPool(config);
  await seedDefaultUser(pool, config.defaultUserId);
  const importQueue = createImportQueue(config);
  const providerQueue = createProviderQueue(config);
  const objectStorage = createS3Client(config);
  const logger = createStructuredLogger({ service: 'api' });
  const metrics = metricsFromQueue(providerQueue, logger);

  const app = Fastify({
    bodyLimit: config.maxChunkBytes,
    disableRequestLogging: true,
    loggerInstance: logger.fastify,
    // A numeric hop count avoids trusting arbitrary client-supplied forwarding chains.
    trustProxy: config.trustedProxyHops ? config.trustedProxyHops : false,
  });

  registerRequestObservability(app, logger);
  registerSafeErrorHandler(app);

  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });
  app.addContentTypeParser('application/zip', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });

  registerCorsPolicy(app, config);

  const selfHostAuth = new SelfHostAuthService(new PostgresSelfHostAuthStore(pool), config.defaultUserId);
  await registerAuthHook(app, config, selfHostAuth);
  // Owner/data/source isolation and the real browser account flow are enabled together.
  const membersReady = options.membersReady ?? true;
  await registerSelfHostAuthRoutes(app, selfHostAuth, config, {
    membersReady,
    resolveIdentity: (userId) => accountIdentity(pool, userId),
  });
  await registerServerManagement(app, [importQueue, providerQueue]);
  await registerPluginRuntimeRoutes(app, config, pool, new URL('../dist/plugin-runtime-assets/', import.meta.url));
  if (config.webRoot) await registerWebAssets(app, config.webRoot);

  const pruneResult = await pruneStaleUploadSessions(pool, config);
  if (pruneResult.prunedCount) {
    logger.info('stale_upload_sessions_pruned', { prunedCount: pruneResult.prunedCount });
  }

  let uploadPrunePromise: Promise<void> | undefined;
  const runScheduledUploadPrune = () => {
    if (uploadPrunePromise) return;
    uploadPrunePromise = pruneStaleUploadSessions(pool, config)
      .then((result) => {
        if (result.prunedCount) logger.info('stale_upload_sessions_pruned', { prunedCount: result.prunedCount });
      })
      .catch((error) => {
        logger.warn('stale_upload_session_prune_failed', {
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });
      })
      .finally(() => {
        uploadPrunePromise = undefined;
      });
  };
  const uploadPruneTimer = setInterval(runScheduledUploadPrune, uploadPruneIntervalMs);
  uploadPruneTimer.unref();

  app.addHook('onClose', async () => {
    clearInterval(uploadPruneTimer);
    await uploadPrunePromise;
    await providerQueue.close();
    await importQueue.close();
    await pool.end();
  });

  await registerMetricsRoute(app, metrics, [
    { label: 'import', queue: importQueue },
    { label: 'provider', queue: providerQueue },
  ]);

  await registerHealthRoutes(app, pool, {
    queue: importQueue,
    checkObjectStorage: () => ensureBucket(objectStorage, config.s3.bucket),
    checkWorker: () => metrics.assertWorkerHeartbeatFresh(),
  });
  await registerUploadRoutes(app, pool, config, importQueue);
  await registerBookRoutes(app, pool, config);
  await registerAIRoutes(app, pool, config, providerQueue);
  await registerSyncRoutes(app, pool, config);
  await registerBackupRoutes(app, pool, config);
  const masterKey = loadProviderSecretMasterKey(config, process.env);
  const extensionVault = new EncryptedSourceCredentialVault(
    path.join(config.dataDir, 'extension-credentials', createHash('sha256').update(config.defaultUserId).digest('hex')),
    masterKey,
  );
  const sourceNetwork = createSourceNetworkSettings(extensionVault, config.sourceOutboundProxy, createByeDpiProcess());
  await sourceNetwork.initialize();
  app.addHook('onClose', () => sourceNetwork.close());
  await registerSourceNetworkSettingsRoutes(app, sourceNetwork);
  const managedMetadata = process.env.BOAA_MANAGED_METADATA_ENDPOINT;
  await registerWebNovelMetadataCollectorGateway(app, config, {
    ...(managedMetadata && managedMetadata === config.webNovelMetadataCollectorUrl
      ? {
          fetchImpl: createManagedMetadataFetch({
            endpoint: managedMetadata,
            resolveDefaultProxy: () => sourceNetwork.resolve(),
          }),
        }
      : {}),
  });
  const apkBuild = path.resolve(
    process.env.BOAA_APK_RUNTIME_DIR ??
      process.env.MOYA_APK_RUNTIME_DIR ??
      process.env.NOVELDESK_APK_RUNTIME_DIR ??
      process.env.MOA_APK_RUNTIME_DIR ??
      'services/apk-worker/build',
  );
  const apkAvailable =
    process.env.BOAA_APK_RUNTIME_ENABLED !== '0' &&
    (await access(path.join(apkBuild, 'target', 'apk-worker-0.1.0.jar')).then(
      () => true,
      () => false,
    ));
  const java =
    process.env.BOAA_APK_JAVA ??
    process.env.MOYA_APK_JAVA ??
    process.env.NOVELDESK_APK_JAVA ??
    process.env.MOA_APK_JAVA ??
    (process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'java') : 'java');
  const apkProcessBudget = new ApkProcessBudget(4);
  const runtimes = new OwnerRuntimeRegistry(async (userId: string) => {
    const legacy = userId === config.defaultUserId;
    if (!legacy) {
      const account = await pool.query(
        "select user_id from self_host_accounts where user_id = $1 and status in ('active','invited')",
        [userId],
      );
      if (!account.rowCount) throw Object.assign(new Error('account_disabled'), { statusCode: 403 });
    }
    const vault = legacy
      ? extensionVault
      : new EncryptedSourceCredentialVault(
          path.join(config.dataDir, 'extension-credentials', createHash('sha256').update(userId).digest('hex')),
          createHmac('sha256', masterKey).update('boaa-owner-source-v1\0').update(userId).digest(),
        );
    // Environment content-service credentials belong only to the preserved administrator.
    const content = legacy ? createConfiguredContentService(process.env, userId) : undefined;
    let apk: ApkExtensionHost | undefined;
    let mangayomi: MangayomiExtensionHost | undefined;
    try {
      if (apkAvailable) {
        try {
          apk = await ApkExtensionHost.open(java, apkBuild, apkOwnerDirectory(config.dataDir, userId), {
            resolveDefaultProxy: () => sourceNetwork.resolve(),
            processBudget: apkProcessBudget,
          });
        } catch {
          app.log.warn('APK extension runtime unavailable');
        }
      }
      try {
        mangayomi = await MangayomiExtensionHost.open(
          path.join(config.dataDir, 'mangayomi-extensions', createHash('sha256').update(userId).digest('hex')),
          vault,
          undefined,
          sourceNetwork,
        );
      } catch {
        app.log.warn('Mangayomi extension runtime unavailable');
      }
      const runtime = createExtensionRuntime(
        new PostgresPackageInstallStore(pool, userId),
        createNodePackageExecution('self-host-gateway', {
          vault,
          allowPrivateNetwork: legacy,
          allowContentService: legacy,
          network: sourceNetwork,
          contentResolver: content?.resolve,
          contentConfigured: content?.configured,
        }),
        apk,
        mangayomi,
      );
      const close = runtime.close;
      runtime.close = async () => {
        await close();
        await content?.dispose();
      };
      return runtime;
    } catch (error) {
      apk?.close();
      mangayomi?.close();
      await content?.dispose();
      throw error;
    }
  });
  app.addHook('onClose', () => runtimes.close());
  const replies = new WeakMap<FastifyRequest, FastifyReply>();
  const requests = new WeakMap<FastifyRequest, Promise<Awaited<ReturnType<typeof runtimes.acquire>>>>();
  const resolveRuntime = async (request: FastifyRequest): Promise<ExtensionRuntime> => {
    let pending = requests.get(request);
    if (!pending) {
      const userId = requireUserId(request);
      if (userId !== config.defaultUserId) {
        const account = await pool.query(
          "select user_id from self_host_accounts where user_id = $1 and status = 'active'",
          [userId],
        );
        if (!account.rowCount) throw Object.assign(new Error('account_disabled'), { statusCode: 403 });
      }
      pending = runtimes.acquire(userId).then((lease) => {
        const abort = () => replies.get(request)?.raw.destroy();
        lease.signal.addEventListener('abort', abort, { once: true });
        if (lease.signal.aborted) abort();
        return {
          ...lease,
          release: () => {
            lease.signal.removeEventListener('abort', abort);
            lease.release();
          },
        };
      });
      requests.set(request, pending);
      request.raw.once('aborted', () => {
        void pending!.then(
          (lease) => lease.release(),
          () => {},
        );
      });
    }
    const lease = await pending;
    bindOwnerRuntimeSignal(request, lease.signal);
    return lease.value;
  };
  app.addHook('onRequest', async (request, reply) => {
    replies.set(request, reply);
    reply.raw.once('close', () => {
      const pending = requests.get(request);
      if (pending)
        void pending.then(
          (lease) => lease.release(),
          () => {},
        );
    });
  });
  app.addHook('onResponse', async (request) => {
    const pending = requests.get(request);
    if (pending)
      await pending.then(
        (lease) => lease.release(),
        () => {},
      );
  });
  await registerAdminAccountRoutes(app, selfHostAuth, {
    membersReady,
    onMemberDisabled: (userId) => runtimes.dispose(userId),
  });
  await registerAdminSourceRoutes(app, pool, runtimes);
  await registerApkExtensionRoutes(
    app,
    undefined,
    '/api/apk-extensions',
    async (request) => (await resolveRuntime(request)).apk,
  );
  await registerApkExtensionRoutes(
    app,
    undefined,
    '/api/mangayomi-extensions',
    async (request) => (await resolveRuntime(request)).mangayomi,
  );
  const textMigration = parseInstalledTextMigration(process.env.EXTENSION_TEXT_MIGRATION);
  const documentS3 = createDocumentS3Client(config);
  app.addHook('onClose', async () => documentS3.destroy());
  await registerExtensionPackageRoutes(
    app,
    new PostgresPackageInstallStore(pool, config.defaultUserId),
    createNodePackageExecution(),
    undefined,
    undefined,
    new Set(textMigration?.sources.map((source) => source.sourceId)),
    (file, input, signal, request) =>
      stageServerImport(pool, requestOwnerConfig(config, request!), file, input, signal),
    {
      read: (bookId, expected, signal, request) =>
        createDocumentSeriesSnapshot(pool, requestOwnerConfig(config, request!), documentS3)(bookId, expected, signal),
      stage: (file, input, signal, request) =>
        stageServerImport(pool, requestOwnerConfig(config, request!), file, input, signal),
    },
    resolveRuntime,
  );
  // Legacy companion (including migrated installed text routes) remains administrator-only in V1.
  await registerTextSourceGateway(app, config, {
    installedFetch: textMigration
      ? async (...args) => {
          const lease = await runtimes.acquire(config.defaultUserId);
          try {
            return await createInstalledTextGateway(lease.value.catalog, textMigration)(...args);
          } finally {
            lease.release();
          }
        }
      : undefined,
  });

  return app;
}
