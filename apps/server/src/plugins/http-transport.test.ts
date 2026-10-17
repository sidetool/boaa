import { describe, expect, it, vi } from 'vitest';
vi.mock('node:os', () => ({ networkInterfaces: () => ({ fixture: [{ address: '192.168.20.10' }] }) }));
import { approvePluginEndpoint, privateOrigins, credentialHeaderAllowed } from './http-transport';
import { pluginHttpRequest, pluginTarget } from '../../../../packages/extension-contracts/plugin-http';
describe('plugin HTTP URL and wire boundaries', () => {
  it('permits custom credential names without transport or cookie overrides', () => {
    for (const h of ['api-key', 'x-api-key', 'authorization']) expect(credentialHeaderAllowed(h)).toBe(true);
    for (const h of ['cookie', 'host', 'content-length', 'x-forwarded-host', 'sec-fetch-site', 'proxy-authorization'])
      expect(credentialHeaderAllowed(h)).toBe(false);
  });
  it('permits scoped relative paths/query and denies authority/path interpretation escapes', () => {
    expect(pluginTarget('https://example.com/v1/', 'notes?q=hello%20world').href).toBe(
      'https://example.com/v1/notes?q=hello%20world',
    );
    for (const path of [
      '//evil.test/',
      'https://evil.test/',
      '/v1/x',
      '../admin',
      '%2e%2e/admin',
      '%252e%252e/admin',
      'a%2fb',
      'a\\b',
      '#fragment',
      'a\n',
    ])
      expect(() => pluginTarget('https://example.com/v1/', path), path).toThrow();
  });
  it('denies private/metadata/mapped/mixed DNS without pinning an unapproved address', async () => {
    for (const ip of ['127.0.0.1', '169.254.169.254', '10.0.0.2', '0.0.0.0', '::1', '::ffff:127.0.0.1'])
      await expect(
        approvePluginEndpoint(`https://${ip.includes(':') ? `[${ip}]` : ip}/`, 'https://boaa.test', []),
      ).rejects.toThrow();
    await expect(
      approvePluginEndpoint('https://public.test/', 'https://boaa.test', [], (async () => [
        { address: '8.8.8.8', family: 4 },
        { address: '10.0.0.1', family: 4 },
      ]) as never),
    ).rejects.toThrow();
    expect(
      (
        await approvePluginEndpoint('https://public.test/', 'https://boaa.test', [], (async () => [
          { address: '8.8.8.8', family: 4 },
        ]) as never)
      ).address.address,
    ).toBe('8.8.8.8');
  });
  it('requires admin exact LAN origin and still blocks Boaa/loopback/metadata', async () => {
    const origins = privateOrigins('["http://192.168.20.10:8123"]');
    await expect(
      approvePluginEndpoint(origins[0] + '/', 'https://boaa.test', origins, undefined, 8123),
    ).rejects.toThrow('HTTP_ENDPOINT_DENIED');
    expect((await approvePluginEndpoint(origins[0] + '/v1/', 'https://boaa.test', origins)).url.port).toBe('8123');
    await expect(approvePluginEndpoint('http://192.168.20.10:8124/', 'https://boaa.test', origins)).rejects.toThrow();
    await expect(approvePluginEndpoint(origins[0] + '/api/', origins[0], origins)).rejects.toThrow();
    for (const origin of ['http://127.0.0.1:12', 'http://169.254.169.254', 'http://localhost:12'])
      expect(() => privateOrigins(JSON.stringify([origin]))).toThrow();
  });
  it('accepts CRUD/text/form and rejects unsupported methods/bodies/header control bytes/oversize', () => {
    const input = {
      slot: 'notes',
      path: 'items',
      method: 'POST',
      response: 'json',
      body: 'a=b',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    };
    expect(pluginHttpRequest(input)).toBe(true);
    for (const patch of [
      { method: 'CONNECT' },
      { method: 'GET' },
      { body: 'x'.repeat(33000) },
      { headers: { cookie: 'x\r\ny' } },
    ])
      expect(pluginHttpRequest({ ...input, ...patch })).toBe(false);
  });
});
