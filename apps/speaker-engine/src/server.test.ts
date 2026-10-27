import { expect, it } from 'vitest';
import { once } from 'node:events';
import { createSpeakerEngineServer } from './server';
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
