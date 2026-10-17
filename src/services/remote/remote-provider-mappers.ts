import type { ProviderJobType, ProviderJobStatus, TTSCacheItem } from '../../providers/provider-jobs';
import type { BookAIWorkflowPlan } from '../../providers/book-ai-workflow-plan';
import type { ExtensionContributionId } from '@boaa/extension-contracts';
import {
  DEFAULT_BOOK_AI_WORKFLOW_DEFINITION_ID,
  DEFAULT_BOOK_AI_WORKFLOW_VERSION,
} from '../../providers/book-ai-workflow-definition';
import type {
  RemoteProviderJob,
  RemoteBookAIWorkflow,
  RemoteBookAIWorkflowJob,
  RemoteProviderSettings,
  RemoteProviderSettingsBundle,
} from './remote-provider-contracts';
import { numberValue, optionalNumberValue, stringValue, sanitizedJobProgressValue } from './remote-value-mappers';
type JsonRecord = Record<string, unknown>;
export function mapServerProviderJob(row: JsonRecord): RemoteProviderJob {
  return {
    id: stringValue(row.id),
    novelId: stringValue(row.novelId, stringValue(row.book_id)),
    chapterId: stringValue(row.chapterId, stringValue(row.chapter_id)) || undefined,
    type: stringValue(row.type, stringValue(row.job_type, 'chapter_segment_labeling')) as ProviderJobType,
    providerId: stringValue(row.providerId, stringValue(row.provider_id)),
    modelId: stringValue(row.modelId, stringValue(row.model_id)) || undefined,
    inputHash: stringValue(row.inputHash, stringValue(row.input_hash)),
    status: stringValue(row.status, 'queued') as ProviderJobStatus,
    stage: stringValue(row.stage) || undefined,
    progress: row.progress === undefined ? undefined : sanitizedJobProgressValue(row.progress),
    createdAt: stringValue(row.createdAt, stringValue(row.created_at, new Date(0).toISOString())),
    updatedAt: stringValue(row.updatedAt, stringValue(row.updated_at, new Date(0).toISOString())),
    startedAt: stringValue(row.startedAt, stringValue(row.started_at)) || undefined,
    finishedAt: stringValue(row.finishedAt, stringValue(row.finished_at)) || undefined,
    errorCode: stringValue(row.errorCode, stringValue(row.error_code)) || undefined,
    errorMessage: stringValue(row.errorMessage, stringValue(row.error_message)) || undefined,
  };
}

export function mapServerBookAIWorkflow(row: JsonRecord): RemoteBookAIWorkflow {
  return {
    id: stringValue(row.id),
    novelId: stringValue(row.novelId, stringValue(row.book_id)),
    workflowType: stringValue(row.workflowType, stringValue(row.workflow_type, 'book_ai_tts')),
    workflowDefinitionId: stringValue(
      row.workflowDefinitionId,
      stringValue(row.workflow_definition_id, DEFAULT_BOOK_AI_WORKFLOW_DEFINITION_ID),
    ) as ExtensionContributionId,
    workflowVersion: stringValue(
      row.workflowVersion,
      stringValue(row.workflow_version, DEFAULT_BOOK_AI_WORKFLOW_VERSION),
    ),
    providerId: stringValue(row.providerId, stringValue(row.provider_id)),
    modelId: stringValue(row.modelId, stringValue(row.model_id)) || undefined,
    planHash: stringValue(row.planHash, stringValue(row.plan_hash)),
    plan: row.plan as BookAIWorkflowPlan,
    status: stringValue(row.status, 'running'),
    stage: stringValue(row.stage, 'building_graph'),
    progress: row.progress === undefined ? undefined : sanitizedJobProgressValue(row.progress),
    jobs: Array.isArray(row.jobs)
      ? row.jobs.map((job): RemoteBookAIWorkflowJob => {
          const body = job && typeof job === 'object' && !Array.isArray(job) ? (job as JsonRecord) : {};
          const providerJob =
            body.job && typeof body.job === 'object' && !Array.isArray(body.job)
              ? mapServerProviderJob(body.job as JsonRecord)
              : undefined;
          return {
            id: stringValue(body.id),
            workflowId: stringValue(body.workflowId, stringValue(body.workflow_id)),
            providerJobId: stringValue(body.providerJobId, stringValue(body.provider_job_id)),
            stage: stringValue(body.stage),
            planItemId: stringValue(body.planItemId, stringValue(body.plan_item_id)),
            sequence: numberValue(body.sequence),
            job: providerJob,
            createdAt: stringValue(body.createdAt, stringValue(body.created_at, new Date(0).toISOString())),
          };
        })
      : [],
    createdAt: stringValue(row.createdAt, stringValue(row.created_at, new Date(0).toISOString())),
    updatedAt: stringValue(row.updatedAt, stringValue(row.updated_at, new Date(0).toISOString())),
    startedAt: stringValue(row.startedAt, stringValue(row.started_at)) || undefined,
    finishedAt: stringValue(row.finishedAt, stringValue(row.finished_at)) || undefined,
    errorCode: stringValue(row.errorCode, stringValue(row.error_code)) || undefined,
    errorMessage: stringValue(row.errorMessage, stringValue(row.error_message)) || undefined,
  };
}

export function mapServerTTSCacheItem(row: JsonRecord): TTSCacheItem {
  return {
    id: stringValue(row.id),
    novelId: stringValue(row.novelId, stringValue(row.book_id)),
    chapterId: stringValue(row.chapterId, stringValue(row.chapter_id)),
    cacheKey: stringValue(row.cacheKey, stringValue(row.cache_key)),
    providerId: stringValue(row.providerId, stringValue(row.provider_id)),
    providerModel: stringValue(row.providerModel, stringValue(row.provider_model)) || undefined,
    providerVersion: stringValue(row.providerVersion, stringValue(row.provider_version)) || undefined,
    voiceProfileId: stringValue(row.voiceProfileId, stringValue(row.voice_profile_id)),
    speakerId: stringValue(row.speakerId, stringValue(row.speaker_id)) || undefined,
    segmentIds: Array.isArray(row.segmentIds)
      ? row.segmentIds.filter((id): id is string => typeof id === 'string')
      : Array.isArray(row.segment_ids)
        ? row.segment_ids.filter((id): id is string => typeof id === 'string')
        : [],
    inputTextHash: stringValue(row.inputTextHash, stringValue(row.input_text_hash)),
    optionsHash: stringValue(row.optionsHash, stringValue(row.options_hash)),
    audioObjectKey: stringValue(row.audioObjectKey, stringValue(row.audio_object_key)),
    contentType: stringValue(row.contentType, stringValue(row.content_type)) || undefined,
    byteSize: optionalNumberValue(row.byteSize, row.byte_size),
    audioHash: stringValue(row.audioHash, stringValue(row.audio_hash)) || undefined,
    durationMs: optionalNumberValue(row.durationMs, row.duration_ms),
    createdAt: stringValue(row.createdAt, stringValue(row.created_at, new Date(0).toISOString())),
    updatedAt: stringValue(row.updatedAt, stringValue(row.updated_at, new Date(0).toISOString())),
  };
}

export function mapProviderSettings(row: JsonRecord): RemoteProviderSettings {
  const providerOptions =
    row.providerOptionsByProvider &&
    typeof row.providerOptionsByProvider === 'object' &&
    !Array.isArray(row.providerOptionsByProvider)
      ? (row.providerOptionsByProvider as Record<string, JsonRecord>)
      : {};
  return {
    scope: stringValue(row.scope, 'llm_labeling') as RemoteProviderSettings['scope'],
    defaultProviderId: stringValue(row.defaultProviderId) || undefined,
    enabledProviderIds: Array.isArray(row.enabledProviderIds)
      ? row.enabledProviderIds.filter((providerId): providerId is string => typeof providerId === 'string')
      : [],
    modelByProvider:
      row.modelByProvider && typeof row.modelByProvider === 'object' && !Array.isArray(row.modelByProvider)
        ? Object.fromEntries(
            Object.entries(row.modelByProvider).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string',
            ),
          )
        : {},
    providerOptionsByProvider: providerOptions,
    updatedAt: stringValue(row.updatedAt) || undefined,
  };
}

export function mapProviderSettingsBundle(row: JsonRecord): RemoteProviderSettingsBundle {
  return {
    llmLabeling: mapProviderSettings(
      row.llmLabeling && typeof row.llmLabeling === 'object' ? (row.llmLabeling as JsonRecord) : {},
    ),
    ttsSynthesis: mapProviderSettings(
      row.ttsSynthesis && typeof row.ttsSynthesis === 'object' ? (row.ttsSynthesis as JsonRecord) : {},
    ),
  };
}
