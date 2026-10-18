import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetReaderDbForTests } from './reader-database';
import { deleteSpokenTextRule, listSpokenTextRules, saveSpokenTextRule } from './spoken-text-rule-store';

describe('spoken text rule store', () => {
  beforeEach(async () => resetReaderDbForTests());

  it('combines global and matching book rules in priority order', async () => {
    await saveSpokenTextRule({
      scope: 'book',
      bookId: 'book-1',
      kind: 'skip_prefix',
      pattern: '[작가의 말]',
      enabled: true,
      priority: 2,
    });
    const global = await saveSpokenTextRule({
      scope: 'global',
      kind: 'skip_line',
      pattern: '***',
      enabled: true,
      priority: 1,
    });

    expect((await listSpokenTextRules('book-1')).map((rule) => rule.pattern)).toEqual(['***', '[작가의 말]']);
    expect((await listSpokenTextRules('book-2')).map((rule) => rule.pattern)).toEqual(['***']);
    await deleteSpokenTextRule(global.id);
    expect(await listSpokenTextRules('book-2')).toEqual([]);
  });
});

it('preserves literal whitespace and imports atomically on validation failure', async () => {
  const { createSpokenTextRuleStore } = await import('./spoken-text-rule-store');
  const store = createSpokenTextRuleStore();
  await resetReaderDbForTests();
  await store.save({
    scope: 'global',
    kind: 'replace_literal',
    pattern: ' a ',
    replacement: ' b ',
    enabled: true,
    priority: 0,
  });
  expect((await store.list())[0]).toMatchObject({ pattern: ' a ', replacement: ' b ' });
  await expect(
    store.saveMany([
      { scope: 'global', kind: 'replace_regex', pattern: 'x', replacement: '', enabled: true, priority: 1 },
      { scope: 'global', kind: 'replace_regex', pattern: '(', replacement: '', enabled: true, priority: 2 },
    ]),
  ).rejects.toThrow();
  expect(await store.list()).toHaveLength(1);
});

it('limits effective rules without partial writes and isolates account stores', async () => {
  const { createSpokenTextRuleStore } = await import('./spoken-text-rule-store');
  const { createAccountReaderDb } = await import('./reader-database');
  const a = createSpokenTextRuleStore(createAccountReaderDb('filter-test-a'));
  const b = createSpokenTextRuleStore(createAccountReaderDb('filter-test-b'));
  await a.saveMany(
    Array.from({ length: 100 }, (_, priority) => ({
      scope: 'global' as const,
      kind: 'replace_literal' as const,
      pattern: `word${priority}`,
      replacement: '',
      enabled: true,
      priority,
    })),
  );
  await expect(
    a.save({ scope: 'book', bookId: 'b', kind: 'replace_literal', pattern: 'x', enabled: true, priority: 101 }),
  ).rejects.toThrow('100개');
  expect(await a.list('b')).toHaveLength(100);
  expect(await b.list('b')).toEqual([]);
});
