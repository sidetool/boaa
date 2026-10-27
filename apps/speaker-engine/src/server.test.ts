import { expect, it } from 'vitest';
import { once } from 'node:events';
import { createSpeakerEngineServer } from './server';
import { source, attribution } from './test-fixtures';
import { ENGINE_VERSION } from './engine';
import { SPEAKER_ENGINE_PROTOCOL } from '../../../src/providers/speaker-engine-protocol';
it('serves only authenticated stateless analysis and never leaks raw invalid input', async () => {
  const token = 'fixture-token-24-characters-only';
  const server = createSpeakerEngineServer(token);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    expect((await fetch(base + '/v1/capabilities')).status).toBe(401);
    expect(
      (await (await fetch(base + '/v1/capabilities', { headers: { Authorization: 'Bearer ' + token } })).json())
        .protocol,
    ).toBe(SPEAKER_ENGINE_PROTOCOL);
    const invalid = await fetch(base + '/v1/step', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: '{"private_source":"not allowed"}',
    });
    expect(invalid.status).toBe(422);
    expect(await invalid.text()).not.toContain('private_source');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('advertises additive A preparation under engine version 2 and serves authenticated source-only checkpoints', async () => {
  const token = 'fixture-token-24-characters-only';
  const server = createSpeakerEngineServer(token);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  try {
    expect(await (await fetch(base + '/v1/capabilities', { headers })).json()).toMatchObject({
      protocol: SPEAKER_ENGINE_PROTOCOL,
      engineVersion: ENGINE_VERSION,
      attributionPreparation: true,
    });
    expect(ENGINE_VERSION).toBe('preset35-boaa-2');
    expect((await fetch(base + '/v1/attribution', { method: 'POST', body: '{}' })).status).toBe(401);
    const first = await (
      await fetch(base + '/v1/attribution', {
        method: 'POST',
        headers,
        body: JSON.stringify({ protocol: SPEAKER_ENGINE_PROTOCOL, source }),
      })
    ).json();
    expect(first).toMatchObject({ kind: 'request', stage: 'attribution' });
    const response = await fetch(base + '/v1/attribution', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        protocol: SPEAKER_ENGINE_PROTOCOL,
        source,
        checkpoint: first.checkpoint,
        response: JSON.stringify(attribution(source)),
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ kind: 'attributed' });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
