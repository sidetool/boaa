import Fastify from 'fastify';
import type pg from 'pg';
import { expect, it, vi } from 'vitest';
import type { ServerConfig } from '../../config.js';
import { registerReaderStateRoutes } from './reader-state-routes.js';

it('round trips independent source rows through PUT/GET settings, preserving duplicates by source and sync payloads', async () => {
  const saved = new Map<string, unknown>();
  const events: unknown[] = [];
  const query = vi.fn(async (sql: string, parameters: unknown[]) => {
    if (sql.includes('insert into reader_settings'))
      saved.set(String(parameters[0]), JSON.parse(String(parameters[1])));
    if (sql.includes('insert into sync_events')) events.push(JSON.parse(String(parameters[6])));
    if (sql.includes('select settings from reader_settings'))
      return { rows: saved.has(String(parameters[0])) ? [{ settings: saved.get(String(parameters[0])) }] : [] };
    return { rows: [], rowCount: 1 };
  });
  const pool = { query } as unknown as pg.Pool;
  const app = Fastify();
  app.addHook('onRequest', async (request) => {
    request.principal = { userId: 'one', role: 'admin', authMethod: 'legacy-token' };
  });
  const other = Fastify();
  other.addHook('onRequest', async (request) => {
    request.principal = { userId: 'two', role: 'admin', authMethod: 'legacy-token' };
  });
  await registerReaderStateRoutes(app, pool, { defaultUserId: 'one' } as ServerConfig);
  await registerReaderStateRoutes(other, pool, { defaultUserId: 'two' } as ServerConfig);
  const rows = [
    { id: 'old', kind: 'discovery', visible: true, discoveryTabId: '["tab","section"]' },
    ...['one', 'two'].map((id, index) => ({
      id,
      kind: 'source',
      visible: index === 0,
      section: {
        sourceId: 'fixture.source',
        mode: 'latest',
        title: `Row ${id}`,
        summary: `Filter ${index}`,
        parentRef: 'category',
        filters: [{ position: 0, groupPosition: 1, value: index }],
        filterSignature: '[]',
      },
    })),
  ];
  try {
    const put = await app.inject({ method: 'PUT', url: '/api/settings', payload: { homeRows: rows } });
    expect(put.statusCode).toBe(200);
    expect(put.json().settings.homeRows).toEqual(rows);
    expect((await app.inject('/api/settings')).json().settings.homeRows).toEqual(rows);
    expect(events).toEqual([expect.objectContaining({ settings: expect.objectContaining({ homeRows: rows }) })]);
    expect((await other.inject('/api/settings')).json().settings.homeRows).toBeUndefined();
    const bad = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { homeRows: [{ id: 'invalid', kind: 'source', visible: true }] },
    });
    expect(bad.statusCode).toBe(400);
    expect((await app.inject('/api/settings')).json().settings.homeRows).toEqual(rows);
  } finally {
    await app.close();
    await other.close();
  }
});
