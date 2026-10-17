import { expect, it } from 'vitest';
import { sharedReaderPositionPersistence, invalidateReaderPositionPersistence } from './reader-progress-controller';
it('orders old and new viewport saves while an independent repository can save immediately', async () => {
  const repository = {},
    calls: string[] = [];
  let release!: () => void;
  const old = sharedReaderPositionPersistence(repository).enqueue(async () => {
    calls.push('old:start');
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    calls.push('old:done');
  });
  const next = sharedReaderPositionPersistence(repository).enqueue(async () => {
    calls.push('next');
  });
  await sharedReaderPositionPersistence({}).enqueue(async () => {
    calls.push('other');
  });
  expect(calls).toEqual(['old:start', 'other']);
  release();
  await Promise.all([old, next]);
  expect(calls).toEqual(['old:start', 'other', 'old:done', 'next']);
});

it('retires queued writes when the same remote repository changes authenticated owner', async () => {
  const repository = {},
    calls: string[] = [];
  let release!: () => void;
  const old = sharedReaderPositionPersistence(repository).enqueue(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  const queued = sharedReaderPositionPersistence(repository).enqueue(async () => {
    calls.push('obsolete');
  });
  await Promise.resolve();
  invalidateReaderPositionPersistence(repository);
  await sharedReaderPositionPersistence(repository).enqueue(async () => {
    calls.push('new-owner');
  });
  release();
  await Promise.all([old, queued]);
  expect(calls).toEqual(['new-owner']);
});
