import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import type { ReaderRepository } from '../../repositories/reader-repository';
import type { Novel, Character, VoiceProfile, LabeledSegment } from '../../domain/types';
import { useBookAIWorkflowController, type BookAIWorkflowControllerInput } from './useBookAIWorkflowController';

export interface BookAIArtifactSnapshot {
  novel?: Novel;
  characters?: Character[];
  voiceProfiles?: VoiceProfile[];
  chapterId?: string;
  segments?: LabeledSegment[];
}
export interface BookAIWorkflowSessionInput extends Omit<
  BookAIWorkflowControllerInput,
  'beforeRun' | 'onTerminal' | 'onCancelled'
> {
  repository: Pick<ReaderRepository, 'getNovel' | 'listCharacters' | 'listVoiceProfiles' | 'listSegments'>;
  activeChapterId: () => string | undefined;
  sync: (phase: 'before_job' | 'after_job') => Promise<boolean>;
  attach: (bookId: string, chapterIds: string[]) => Promise<boolean>;
  publish: (snapshot: BookAIArtifactSnapshot) => void;
}
/** Coordinates provider synchronization and artifact adoption around the existing workflow lane. */
export function useBookAIWorkflowSession(input: BookAIWorkflowSessionInput) {
  const { sessionOwner, bookId, runner, repository } = input;
  const scope = useMemo(
    () => ({ sessionOwner, bookId, runner, repository, active: false, epoch: 0, refresh: 0 }),
    [sessionOwner, bookId, runner, repository],
  );
  const latest = useRef(scope);
  latest.current = scope;
  useLayoutEffect(() => {
    scope.active = true;
    scope.epoch++;
    return () => {
      scope.active = false;
      scope.epoch++;
    };
  }, [scope]);
  const current = useCallback(() => scope.active && latest.current === scope, [scope]);
  const refreshArtifacts = async (target: string, novelOnly = false, operationCurrent: () => boolean = () => true) => {
    if (!current() || target !== bookId) return false;
    const epoch = scope.epoch,
      request = ++scope.refresh;
    const valid = () => current() && scope.epoch === epoch && scope.refresh === request && operationCurrent();
    if (!novelOnly && runner?.runtime === 'hosted' && !(await input.sync('after_job'))) return false;
    if (!valid()) return false;
    const chapterId = input.activeChapterId();
    const [novel, characters, voiceProfiles, segments] = await Promise.all([
      repository.getNovel(target),
      novelOnly ? undefined : repository.listCharacters(target),
      novelOnly ? undefined : repository.listVoiceProfiles(target),
      !novelOnly && chapterId ? repository.listSegments(chapterId) : undefined,
    ]);
    if (!valid()) return false;
    const sameChapter = input.activeChapterId() === chapterId;
    input.publish({
      novel,
      characters,
      voiceProfiles,
      chapterId: sameChapter ? chapterId : undefined,
      segments: sameChapter ? segments : undefined,
    });
    return true;
  };
  const controller = useBookAIWorkflowController({
    ...input,
    beforeRun: async (target, chapters, operationCurrent) => {
      const epoch = scope.epoch;
      const valid = () => current() && scope.epoch === epoch && target === bookId && operationCurrent();
      if (!valid()) return false;
      if (runner?.runtime === 'native') return true;
      if (!(await input.sync('before_job')) || !valid()) return false;
      const attached = await input.attach(target, [...chapters]);
      return attached && valid();
    },
    onTerminal: (target, _workflow, operationCurrent) => refreshArtifacts(target, false, operationCurrent),
    onCancelled: async (target, _workflow, operationCurrent) => {
      await refreshArtifacts(target, true, operationCurrent);
    },
  });
  return { ...controller, refreshArtifacts };
}
