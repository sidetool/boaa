import { useLayoutEffect, useMemo, useRef, type MutableRefObject } from 'react';
import type { VoiceProfile } from '../../domain/types';
import { voiceProfileId } from '../../domain/identity/ai-identities';
import { voiceProfilesRevision } from '../../domain/resource-revisions';
import type { AnalysisArtifactRepository } from '../../repositories/reader-repository';
import type { TTSVoice } from '../../providers/tts';
import type { ProviderOptionConfig } from '../../providers/provider-jobs';
import { providerOptionsContainSecretLikeValue, setProviderOptionInRecord } from '../../providers/provider-settings-ui';
import type { RemoteProviderSettings } from '../../services/remote/remote-api-client';

interface VoiceTarget {
  role: VoiceProfile['role'];
  characterId?: string;
  label: string;
}
export interface VoiceProfileEditorInput {
  readonly bookId?: string;
  readonly contentRevision?: string;
  readonly repository: Pick<AnalysisArtifactRepository, 'saveVoiceProfiles' | 'listVoiceProfiles'>;
  readonly profiles: MutableRefObject<VoiceProfile[]>;
  readonly setProfiles: (profiles: VoiceProfile[]) => void;
  readonly voices: readonly TTSVoice[];
  readonly hostedProvider?: { providerId: string; displayName: string };
  readonly settings?: RemoteProviderSettings;
  readonly refreshAfterSave: () => Promise<unknown>;
  readonly reconcile: (profiles: VoiceProfile[]) => Promise<unknown>;
  readonly invalidateReadiness: () => void;
  readonly notify: (message: string, tone: 'success' | 'warning') => void;
}
const matches = (profile: VoiceProfile, target: VoiceTarget, providerId: string) =>
  profile.providerId === providerId &&
  profile.role === target.role &&
  (target.characterId ? profile.characterId === target.characterId : !profile.characterId);

/** Owns the optimistic CAS queue for the mounted App session, independently of the TTS panel. */
export function useVoiceProfileEditor(input: VoiceProfileEditorInput) {
  const queue = useRef(Promise.resolve());
  const version = useRef(0);
  const scope = useMemo(
    () => ({
      active: false,
      epoch: 0,
      bookId: input.bookId,
      contentRevision: input.contentRevision,
      repository: input.repository,
    }),
    [input.bookId, input.contentRevision, input.repository],
  );
  useLayoutEffect(() => {
    scope.active = true;
    scope.epoch++;
    return () => {
      scope.active = false;
      scope.epoch++;
    };
  }, [scope]);

  const save = async (previous: VoiceProfile[], next: VoiceProfile[], success: string, failure: string) => {
    if (!scope.active || !input.bookId) return;
    const bookId = input.bookId;
    const owner = scope.epoch;
    const saveVersion = ++version.current;
    const current = () => scope.active && owner === scope.epoch;
    const latest = () => current() && saveVersion === version.current;
    input.profiles.current = next;
    input.setProfiles(next);
    const task = queue.current
      .catch(() => undefined)
      .then(async () => {
        await input.repository.saveVoiceProfiles(bookId, next, { expectedRevision: voiceProfilesRevision(previous) });
        // A dispatched write retains its original book, but must not refresh a replacement screen.
        if (current()) await input.refreshAfterSave();
      });
    queue.current = task.catch(() => undefined);
    try {
      await task;
      if (!current()) return;
      await input.reconcile(next).catch((error: unknown) => {
        if (current())
          input.notify(error instanceof Error ? error.message : '화자 음성 배정을 갱신하지 못했습니다.', 'warning');
      });
      if (!current()) return;
      input.invalidateReadiness();
      if (latest()) input.notify(success, 'success');
    } catch {
      if (latest()) {
        const restored = await input.repository.listVoiceProfiles(bookId).catch(() => previous);
        if (latest()) {
          input.profiles.current = restored;
          input.setProfiles(restored);
        }
      }
      if (current()) input.notify(failure, 'warning');
    }
  };

  const saveVoice = async (target: VoiceTarget, rawVoiceId: string, hosted: boolean) => {
    if (!scope.active || !input.bookId || (hosted && !input.hostedProvider)) return;
    const providerId = hosted ? input.hostedProvider!.providerId : 'system';
    const providerVoiceId = hosted ? rawVoiceId.trim() : rawVoiceId;
    const previous = input.profiles.current;
    const existing = previous.find((profile) => matches(profile, target, providerId));
    if (hosted && (existing?.providerVoiceId ?? '') === providerVoiceId) return;
    const next = previous.filter((profile) => !matches(profile, target, providerId));
    if (providerVoiceId) {
      const voice = input.voices.find((item) => item.id === providerVoiceId);
      next.push({
        ...(existing ?? {}),
        id:
          existing?.id ??
          voiceProfileId({ novelId: input.bookId, role: target.role, characterId: target.characterId, providerId }),
        novelId: input.bookId,
        characterId: target.characterId,
        role: target.role,
        providerId,
        providerVoiceId,
        ...(hosted ? { providerModel: input.settings?.modelByProvider[providerId] } : { language: voice?.lang }),
        label: hosted
          ? `${target.label} · ${input.hostedProvider!.displayName} ${providerVoiceId}`
          : `${target.label} · ${voice?.label ?? providerVoiceId}`,
        speed: existing?.speed ?? 1,
        providerOptions: existing?.providerOptions ?? {},
        isUserSelected: true,
      });
    }
    const label = `${target.label}${hosted ? ' hosted' : ''} 음성`;
    await save(
      previous,
      next,
      providerVoiceId ? `${label}을 저장했습니다.` : `${label} 지정을 해제했습니다.`,
      `${label}을 저장하지 못했습니다.`,
    );
  };
  const saveHostedOption = async (
    target: VoiceTarget,
    option: Pick<ProviderOptionConfig, 'optionKey' | 'valueType'>,
    value: string | number | boolean | undefined,
  ) => {
    if (!scope.active || !input.bookId || !input.hostedProvider) return;
    const owner = scope.epoch;
    const { providerId, displayName } = input.hostedProvider;
    // Resolve the optional module before taking the optimistic/CAS snapshot. Another edit may run while loading.
    const { defaultHostedVoiceId } = await import('../../providers/hosted-voice-default');
    if (!scope.active || owner !== scope.epoch) return;
    const previous = input.profiles.current;
    const existing = previous.find((profile) => matches(profile, target, providerId));
    const options = setProviderOptionInRecord(existing?.providerOptions, option, value);
    if (
      (!existing && !Object.keys(options).length) ||
      JSON.stringify(existing?.providerOptions ?? {}) === JSON.stringify(options)
    )
      return;
    if (providerOptionsContainSecretLikeValue(options)) {
      input.notify('Voice profile 옵션에는 API key, token, credential 값을 저장할 수 없습니다.', 'warning');
      return;
    }
    const providerVoiceId = existing?.providerVoiceId?.trim() || defaultHostedVoiceId(providerId, input.settings);
    const next = previous.filter((profile) => !matches(profile, target, providerId));
    next.push({
      ...(existing ?? {}),
      id:
        existing?.id ??
        voiceProfileId({ novelId: input.bookId, role: target.role, characterId: target.characterId, providerId }),
      novelId: input.bookId,
      characterId: target.characterId,
      role: target.role,
      providerId,
      providerVoiceId,
      providerModel: input.settings?.modelByProvider[providerId],
      label: `${target.label} - ${displayName} ${providerVoiceId}`,
      speed: existing?.speed ?? 1,
      providerOptions: options,
      isUserSelected: true,
    });
    await save(
      previous,
      next,
      `${target.label} hosted voice 옵션을 저장했습니다.`,
      `${target.label} hosted voice 옵션을 저장하지 못했습니다.`,
    );
  };
  return {
    saveSystemVoice: (target: VoiceTarget, voice: string) => saveVoice(target, voice, false),
    saveHostedVoice: (target: VoiceTarget, voice: string) => saveVoice(target, voice, true),
    saveHostedOption,
  };
}
