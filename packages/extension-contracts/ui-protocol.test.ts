import { expect, it } from 'vitest';
import { isUiJson, UI_LIMITS } from './ui-json';
import {
  validateUiRequest,
  validateUiResponse,
  validateUiCancel,
  validateUiCommandInvocation,
  validateUiCommandResult,
  validateUiContextEvent,
} from './ui-protocol';
import type { UiMethod } from './ui-dto';
const request = (method: string, params: unknown) => ({
  wireVersion: 1,
  kind: 'request',
  sessionId: 'session-1',
  requestId: 'request-1',
  method,
  params,
});
const response = (result: unknown) => ({
  wireVersion: 1,
  kind: 'response',
  sessionId: 'session-1',
  requestId: 'request-1',
  ok: true,
  result,
});

it.each<[UiMethod, unknown, unknown]>([
  ['runtime.getCapabilities', {}, { apiVersion: 1, apiMinor: 0, features: ['ui.readerAddonTabs'] }],
  [
    'commands.register',
    { commandId: 'org.example.wordbook.capture', handlerId: 'handler-1' },
    { registrationId: 'registration-1' },
  ],
  ['commands.unregister', { registrationId: 'registration-1' }, null],
  [
    'reader.consumeSelection',
    { token: 'token-1' },
    {
      schemaVersion: 1,
      text: '가나다',
      location: { schemaVersion: 1, bookId: 'book-1', documentRevision: 'revision-1', locator: 'v1:opaque' },
      capturedAt: '2026-10-02T00:00:00.000Z',
      textSource: 'original',
    },
  ],
  ['storage.get', { key: 'word' }, { found: true, value: { text: '단어' }, revision: 1 }],
  [
    'storage.set',
    { key: 'word', value: ['단어'], expectedRevision: null, idempotencyKey: 'write-1' },
    { revision: 1, receiptId: 'receipt-1' },
  ],
  [
    'storage.remove',
    { key: 'word', expectedRevision: 1, idempotencyKey: 'remove-1' },
    { revision: 2, receiptId: 'receipt-2' },
  ],
  [
    'storage.list',
    { limit: 10, prefix: '' },
    { items: [{ key: 'word', value: null, revision: 1 }], nextCursor: 'cursor-1' },
  ],
])('validates method-bound %s params and result', (method, params, result) => {
  expect(validateUiRequest(request(method, params))).toBe(true);
  expect(validateUiResponse(response(result), method)).toBe(true);
  expect(validateUiRequest(request(method, { ...(params as object), pluginId: 'forged-owner' }))).toBe(false);
});
it.each([
  ['constructor', {}],
  ['__proto__', {}],
  ['network.fetch', { url: 'https://api.example' }],
  ['commands.register', { commandId: 'c', handlerId: () => null }],
  ['storage.set', { key: 'k', value: 1, expectedRevision: -1, idempotencyKey: 'r' }],
  ['storage.set', { key: 'k', value: 1, expectedRevision: 0, idempotencyKey: 'r' }],
  ['storage.remove', { key: 'k', expectedRevision: null, idempotencyKey: 'r' }],
  ['storage.list', { limit: 101 }],
  ['storage.list', { limit: 0 }],
  ['storage.get', { key: '' }],
])('rejects invalid params for %s', (method, params) => expect(validateUiRequest(request(method, params))).toBe(false));

it('counts UTF-8/envelope bytes and applies smaller selection and value bounds', () => {
  expect(
    validateUiRequest(
      request('storage.set', { key: 'k', value: '한'.repeat(22000), expectedRevision: null, idempotencyKey: 'r' }),
    ),
  ).toBe(false);
  // A value at its own ceiling still needs envelope space in a 64 KiB request.
  expect(
    validateUiRequest(
      request('storage.set', {
        key: 'k',
        value: 'x'.repeat(UI_LIMITS.valueBytes - 2),
        expectedRevision: null,
        idempotencyKey: 'r',
      }),
    ),
  ).toBe(false);
  expect(
    validateUiResponse(response({ found: true, value: 'x'.repeat(UI_LIMITS.valueBytes), revision: 1 }), 'storage.get'),
  ).toBe(false);
  const selection = {
    schemaVersion: 1,
    text: '한'.repeat(6000),
    location: { schemaVersion: 1, bookId: 'b', documentRevision: 'r', locator: 'v1:x' },
    capturedAt: '2026-10-02T00:00:00.000Z',
    textSource: 'original',
  };
  expect(validateUiResponse(response(selection), 'reader.consumeSelection')).toBe(false);
  selection.text = 'ok';
  selection.capturedAt = '2026-02-31T00:00:00.000Z';
  expect(validateUiResponse(response(selection), 'reader.consumeSelection')).toBe(false);
  const items = Array.from({ length: 10 }, (_, i) => ({ key: `k${i}`, revision: 1, value: 'x'.repeat(30000) }));
  expect(validateUiResponse(response({ items }), 'storage.list')).toBe(false);
});

it('rejects mismatched results, duplicate list keys and errors carrying secret diagnostics', () => {
  expect(validateUiResponse(response({ registrationId: 'r' }), 'storage.get')).toBe(false);
  expect(validateUiResponse(response({ found: false, value: 'secret' }), 'storage.get')).toBe(false);
  expect(
    validateUiResponse(response({ items: Array(2).fill({ key: 'k', value: 1, revision: 1 }) }), 'storage.list'),
  ).toBe(false);
  const error = {
    wireVersion: 1,
    kind: 'response',
    sessionId: 's',
    requestId: 'r',
    ok: false,
    error: { code: 'PERMISSION_DENIED', retryable: false },
  };
  expect(validateUiResponse(error, 'storage.get')).toBe(true);
  expect(validateUiResponse({ ...error, error: { ...error.error, stack: 'secret path' } }, 'storage.get')).toBe(false);
});
it('has distinct directions for invocation, cancellation and context snapshots', () => {
  const base = { wireVersion: 1, sessionId: 's', requestId: 'r' };
  const invocation = { ...base, kind: 'invoke', handlerId: 'h', invocationId: 'i', selectionToken: 't' };
  expect(validateUiCommandInvocation(invocation)).toBe(true);
  expect(validateUiRequest(invocation)).toBe(false);
  expect(validateUiCommandResult({ ...base, kind: 'invocationResult', ok: true })).toBe(true);
  expect(validateUiCancel({ ...base, kind: 'cancel' })).toBe(true);
  expect(validateUiCancel({ ...base, kind: 'cancel', pluginId: 'other' })).toBe(false);
  const event = {
    wireVersion: 1,
    kind: 'event',
    sessionId: 's',
    eventId: 'e',
    sequence: 1,
    event: 'ui.contextChanged',
    payload: { theme: 'dark', locale: 'ko', panelId: 'org.example.panel' },
  };
  expect(validateUiContextEvent(event)).toBe(true);
  expect(validateUiContextEvent({ ...event, sequence: 0 })).toBe(false);
});
it('rejects non-JSON, prototype attacks, accessors, depth and sparse arrays before stringify', () => {
  const cycle: unknown[] = [];
  cycle.push(cycle);
  let nested: unknown = null;
  for (let i = 0; i < 25; i++) nested = [nested];
  const values = [
    NaN,
    Infinity,
    1n,
    undefined,
    () => null,
    new Date(),
    new Uint8Array([1]),
    new Map(),
    cycle,
    nested,
    Array(3),
    JSON.parse('{"constructor":{}}'),
    JSON.parse('{"__proto__":{}}'),
    { x: undefined },
    Object.assign([], { extra: 1 }),
  ];
  for (const value of values) expect(isUiJson(value, 65536)).toBe(false);
  let called = false;
  const getter = {
    get x() {
      called = true;
      return 1;
    },
    toJSON() {
      called = true;
      return {};
    },
  };
  expect(isUiJson(getter, 65536)).toBe(false);
  expect(called).toBe(false);
  expect(isUiJson({ [Symbol('x')]: 1 }, 65536)).toBe(false);
  expect(isUiJson(Object.assign(Object.create(null), { safe: [null, true, '한'] }), 65536)).toBe(true);
});
