import { expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import type { ServerConfig } from '../config';
import { resolvePluginRequestOrigin } from './plugin-origin';
it('works on its secure browser host without extra server configuration and rejects cross-site/null origins', () => {
  const config = {} as ServerConfig;
  const request = (headers: Record<string, string | undefined>) => ({ headers }) as FastifyRequest;
  expect(
    resolvePluginRequestOrigin(request({ host: 'reader.example', referer: 'https://reader.example/settings' }), config),
  ).toBe('https://reader.example');
  expect(resolvePluginRequestOrigin(request({ host: 'localhost:1421', origin: 'http://localhost:1421' }), config)).toBe(
    'http://localhost:1421',
  );
  for (const headers of [
    { host: 'reader.example', origin: 'https://evil.example' },
    { host: 'reader.example', origin: 'null' },
    { host: 'reader.example', origin: 'http://reader.example' },
    { host: 'reader.example', origin: 'https://reader.example', 'sec-fetch-site': 'cross-site' },
  ])
    expect(() => resolvePluginRequestOrigin(request(headers), config)).toThrow();
  expect(() =>
    resolvePluginRequestOrigin(request({ host: 'other.example', origin: 'https://other.example' }), {
      pluginOrigin: 'https://reader.example',
    } as ServerConfig),
  ).toThrow();
});
