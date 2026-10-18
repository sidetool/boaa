import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import { registerServerManagement } from '../management/server-management.js';
import { registerMetricsRoute, type ObservabilityMetrics } from '../observability/metrics.js';
import { createSourceNetworkSettings } from '../extensions/source-network-settings.js';
import { registerSourceNetworkSettingsRoutes } from './source-network-settings.js';
import { registerTextSourceGateway } from './text-source-gateway.js';
import { registerWebNovelMetadataCollectorGateway } from './webnovel-metadata-collector-gateway.js';

it('denies members global controls and single-owner companions before accessing operator state', async () => {
  const app = Fastify();
  app.addHook('onRequest', async (request) => {
    request.principal = { userId: 'member', role: 'member', authMethod: 'session' };
  });
  const transport = vi.fn<typeof fetch>();
  const metrics = { renderPrometheus: vi.fn() } as unknown as ObservabilityMetrics;
  await registerServerManagement(app, [], '');
  await registerMetricsRoute(app, metrics, []);
  await registerSourceNetworkSettingsRoutes(
    app,
    createSourceNetworkSettings(undefined, 'http://operator-private:8080'),
  );
  await registerTextSourceGateway(app, loadConfig({ TEXT_SOURCE_SERVER_URL: 'http://synthetic-companion:8080' }), {
    fetchImpl: transport,
  });
  await registerWebNovelMetadataCollectorGateway(app, loadConfig({}), { fetchImpl: transport });
  try {
    for (const url of [
      '/api/admin/system',
      '/api/admin/%73ystem',
      '/metrics',
      '/api/source-network-settings',
      '/api/integrations/text-sources/v1/health',
      '/api/integrations/webnovel-metadata/health',
    ]) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(403);
    }
    expect(
      (await app.inject({ method: 'POST', url: '/api/admin/system/requests', payload: { action: 'update' } }))
        .statusCode,
    ).toBe(403);
    expect((await app.inject({ method: 'PUT', url: '/api/source-network-settings', payload: {} })).statusCode).toBe(
      403,
    );
    expect(transport).not.toHaveBeenCalled();
    expect(metrics.renderPrometheus).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
