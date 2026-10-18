import { useEffect, useMemo, useRef, useState } from 'react';
import type { SpokenTextRule } from '../../domain/types';
import { createSpokenTextRuleStore } from '../../storage/spoken-text-rule-store';

export interface SpokenTextFilterDraft {
  id?: string;
  scope: 'book' | 'global';
  kind: 'replace_literal' | 'replace_regex';
  pattern: string;
  replacement: string;
  enabled: boolean;
  priority?: number;
}
export function useSpokenTextFilters(input: {
  bookId?: string;
  openDb?: () => Promise<IDBDatabase>;
  onChanged(): void;
  onError?(message: string): void;
}) {
  const store = useMemo(() => createSpokenTextRuleStore(input.openDb), [input.openDb]);
  const owner = useMemo(() => ({ store, bookId: input.bookId }), [store, input.bookId]);
  const currentOwner = useRef<object>(owner);
  currentOwner.current = owner;
  const onError = useRef(input.onError);
  onError.current = input.onError;
  const onChanged = useRef(input.onChanged);
  onChanged.current = input.onChanged;
  const [snapshot, setSnapshot] = useState<{ owner: object; rules: SpokenTextRule[] }>();
  const generation = useRef(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const rules = snapshot?.owner === owner ? snapshot.rules : [];
  useEffect(() => {
    currentOwner.current = owner;
    const token = ++generation.current;
    void store
      .list(input.bookId)
      .then((loaded) => {
        if (generation.current === token && currentOwner.current === owner) setSnapshot({ owner, rules: loaded });
      })
      .catch(() => {
        if (currentOwner.current === owner)
          onError.current?.('낭독 필터를 불러오지 못했어요. 듣기 화면을 다시 열어 주세요.');
      });
    return () => {
      if (currentOwner.current === owner) currentOwner.current = {};
    };
  }, [store, owner, input.bookId]);

  const mutate = (work: (existing: SpokenTextRule[]) => Promise<unknown>) => {
    const run = queue.current
      .catch(() => undefined)
      .then(async () => {
        if (currentOwner.current !== owner) throw new Error('책이 바뀌었어요. 현재 책에서 다시 열어 주세요.');
        ++generation.current;
        const existing = await store.list(input.bookId);
        if (currentOwner.current !== owner) throw new Error('책이 바뀌었어요. 현재 책에서 다시 열어 주세요.');
        await work(existing);
        if (currentOwner.current !== owner) return;
        onChanged.current();
        const loaded = await store.list(input.bookId);
        if (currentOwner.current === owner) setSnapshot({ owner, rules: loaded });
      });
    queue.current = run;
    return run;
  };
  const saveMany = (drafts: readonly SpokenTextFilterDraft[]) =>
    mutate(async (existing) => {
      const max = Math.max(-1, ...existing.map((rule) => rule.priority));
      const saved = drafts.map((draft, index) => {
        const previous = draft.id ? existing.find((rule) => rule.id === draft.id) : undefined;
        if (draft.id && !previous) throw new Error('규칙이 바뀌었어요. 목록을 다시 열어 주세요.');
        return {
          ...draft,
          bookId: draft.scope === 'book' ? input.bookId : undefined,
          priority: draft.priority ?? previous?.priority ?? max + index + 1,
        };
      });
      await store.saveMany(saved);
    });
  const saveSkip = (
    pattern: string,
    kind: Extract<SpokenTextRule['kind'], 'skip_line' | 'skip_prefix' | 'skip_suffix'>,
  ) =>
    mutate(async (existing) => {
      await store.save({
        scope: input.bookId ? 'book' : 'global',
        bookId: input.bookId,
        kind,
        pattern,
        enabled: true,
        priority: Math.max(-1, ...existing.map((rule) => rule.priority)) + 1,
      });
    });
  const remove = (id: string) =>
    mutate(async (existing) => {
      if (!existing.some((rule) => rule.id === id)) throw new Error('규칙을 찾지 못했어요.');
      await store.remove(id);
    });
  return {
    ready: snapshot?.owner === owner,
    rules,
    save: (draft: SpokenTextFilterDraft) => saveMany([draft]),
    saveMany,
    saveSkip,
    remove,
  };
}
