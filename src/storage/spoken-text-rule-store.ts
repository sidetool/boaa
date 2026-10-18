import type { SpokenTextRule } from '../domain/types';
import { validateSpokenTextFilter } from '@boaa/text-core/spoken-text-filter';
import { DOCUMENT_LISTENING_STORES } from './document-listening-schema';
import { requestToPromise, transactionDone } from './indexeddb-transaction';
import { openReaderDb } from './reader-database';

type RuleInput = Omit<SpokenTextRule, 'id' | 'updatedAt'> & { readonly id?: string; readonly updatedAt?: string };
export function createSpokenTextRuleStore(openDb: () => Promise<IDBDatabase> = openReaderDb) {
  async function list(bookId?: string): Promise<SpokenTextRule[]> {
    const db = await openDb();
    const tx = db.transaction(DOCUMENT_LISTENING_STORES.spokenTextRules, 'readonly');
    const rules = await requestToPromise<SpokenTextRule[]>(
      tx.objectStore(DOCUMENT_LISTENING_STORES.spokenTextRules).getAll(),
    );
    return rules
      .filter((rule) => rule.scope === 'global' || (bookId !== undefined && rule.bookId === bookId))
      .sort(
        (left, right) =>
          left.priority - right.priority ||
          left.updatedAt.localeCompare(right.updatedAt) ||
          left.id.localeCompare(right.id),
      );
  }
  async function saveMany(inputs: readonly RuleInput[]): Promise<SpokenTextRule[]> {
    if (inputs.length > 100) throw new Error('규칙은 최대 100개까지 저장할 수 있어요.');
    const rules = inputs.map((input): SpokenTextRule => {
      const replacementRule = input.kind === 'replace_literal' || input.kind === 'replace_regex';
      const rule: SpokenTextRule = {
        ...input,
        id: input.id ?? `spoken_rule_${crypto.randomUUID()}`,
        pattern: replacementRule ? input.pattern : input.pattern.trim(),
        replacement: input.replacement,
        bookId: input.scope === 'global' ? undefined : input.bookId,
        updatedAt: new Date().toISOString(),
      };
      if (!rule.pattern || rule.pattern.length > 256 || !Number.isFinite(rule.priority))
        throw new Error('규칙을 확인해 주세요.');
      if (rule.scope === 'book' && !rule.bookId) throw new Error('책을 먼저 열어 주세요.');
      if (replacementRule) {
        const error = validateSpokenTextFilter({ ...rule, kind: input.kind as 'replace_literal' | 'replace_regex' });
        if (error) throw new Error(error);
      }
      return rule;
    });
    const db = await openDb();
    const tx = db.transaction(DOCUMENT_LISTENING_STORES.spokenTextRules, 'readwrite');
    const done = transactionDone(tx);
    const store = tx.objectStore(DOCUMENT_LISTENING_STORES.spokenTextRules);
    const existing = await requestToPromise<SpokenTextRule[]>(store.getAll());
    const ids = new Set(rules.map((rule) => rule.id));
    const merged = [...existing.filter((rule) => !ids.has(rule.id)), ...rules];
    const globals = merged.filter((rule) => rule.scope === 'global').length;
    const books = new Map<string, number>();
    for (const rule of merged)
      if (rule.scope === 'book' && rule.bookId) books.set(rule.bookId, (books.get(rule.bookId) ?? 0) + 1);
    if (globals > 100 || [...books.values()].some((count) => count + globals > 100)) {
      tx.abort();
      await done.catch(() => undefined);
      throw new Error('한 책에 적용하는 규칙은 전체 책 규칙을 포함해 최대 100개예요.');
    }
    for (const rule of rules) store.put(rule);
    await done;
    return rules;
  }
  async function save(input: RuleInput) {
    return (await saveMany([input]))[0];
  }
  async function remove(id: string): Promise<void> {
    const db = await openDb();
    const tx = db.transaction(DOCUMENT_LISTENING_STORES.spokenTextRules, 'readwrite');
    tx.objectStore(DOCUMENT_LISTENING_STORES.spokenTextRules).delete(id);
    await transactionDone(tx);
  }
  return { list, save, saveMany, remove };
}
const defaults = createSpokenTextRuleStore();
export const listSpokenTextRules = defaults.list;
export const saveSpokenTextRule = defaults.save;
export const deleteSpokenTextRule = defaults.remove;
