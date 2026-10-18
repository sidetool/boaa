import { requireAdmin } from '../auth.js';
import { registerPlainTTSRoutes } from './ai/plain-tts-routes.js';
import type { Queue } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import type { ServerConfig } from '../config.js';
import { registerAnalysisWorkflowRoutes } from './ai/analysis-workflow-routes.js';
import { registerArtifactRoutes } from './ai/artifact-routes.js';
import { registerProviderIntegrationRoutes } from './ai/provider-integration-routes.js';
import { registerProviderJobRoutes } from './ai/provider-job-routes.js';
import { registerLabelMutationRoutes } from './ai/label-mutation-routes.js';
import { registerTTSCacheRoutes } from './ai/tts-cache-routes.js';
import { registerCharacterGraphV2Routes } from './ai/character-graph-v2-routes.js';
import { registerVoiceProductRoutes } from './ai/voice-product-routes.js';
import { registerVoiceCastingRoutes } from './ai/voice-casting-routes.js';

export async function registerAIRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  config: ServerConfig,
  providerQueue?: Queue,
): Promise<void> {
  // Provider and workflow adapters remain administrator-only until all execution paths are owner-bound.
  await app.register(async (app) => {
    app.addHook('preHandler', async (request) => {
      const principal = requireAdmin(request);
      if (principal.userId !== config.defaultUserId)
        throw Object.assign(new Error('provider_capability_unavailable'), { statusCode: 403 });
    });
    await registerProviderIntegrationRoutes(app, pool, config);
    await registerAnalysisWorkflowRoutes(app, pool, config, providerQueue);
    await registerProviderJobRoutes(app, pool, config, providerQueue);
    await registerLabelMutationRoutes(app, pool, config);
    await registerTTSCacheRoutes(app, pool, config, providerQueue);
    await registerPlainTTSRoutes(app, pool, config);
    await registerArtifactRoutes(app, pool, config);
    await registerCharacterGraphV2Routes(app, pool, config);
    await registerVoiceProductRoutes(app, pool, config);
    await registerVoiceCastingRoutes(app, pool, config);
  });
}
