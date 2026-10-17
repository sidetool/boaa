import { expect, it } from 'vitest';
import { remoteAccessAddress } from './use-remote-access-settings-model';
it('resolves shareable addresses, strips API suffixes and rejects credentials and non-HTTP schemes', () => {
  expect(remoteAccessAddress('/prefix/api?token=hidden#section', 'https://reader.example/').address?.href).toBe(
    'https://reader.example/prefix/',
  );
  for (const address of [
    'https://user:password@reader.example/api',
    'file:///api',
    'javascript:alert(1)',
    'http://[invalid',
  ]) {
    expect(remoteAccessAddress(address).address).toBeUndefined();
  }
  for (const address of ['http://localhost/api', 'http://127.2.3.4/api', 'http://[::1]/api']) {
    expect(remoteAccessAddress(address).loopback).toBe(true);
  }
  expect(remoteAccessAddress().address).toBeUndefined();
});
