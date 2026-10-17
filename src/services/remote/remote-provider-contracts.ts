import type {
  ProviderJob,
  ProviderCatalogItem,
  ProviderSecretStatus,
  ProviderJobType,
} from '../../providers/provider-jobs';
import type { JsonValue } from '@boaa/contracts/sync';
import type { BookAIWorkflowPlan, BookAIWorkflowPlanOptions } from '../../providers/book-ai-workflow-plan';
import type { ExtensionContributionId } from '@boaa/extension-contracts';
type JsonRecord = Record<string, unknown>;
export interface RemoteProviderJob extends ProviderJob {
  readonly stage?: string;
  readonly progress?: JsonValue;
}

export interface RemoteProviderCatalog {
  readonly aiProviders: ProviderCatalogItem[];
  readonly ttsProviders: ProviderCatalogItem[];
}

export interface RemoteProviderSettings {
  readonly scope: 'llm_labeling' | 'tts_synthesis';
  readonly defaultProviderId?: string;
  readonly enabledProviderIds: string[];
  readonly modelByProvider: Record<string, string>;
  readonly providerOptionsByProvider: Record<string, JsonRecord>;
  readonly updatedAt?: string;
}

export interface RemoteProviderSettingsBundle {
  readonly llmLabeling: RemoteProviderSettings;
  readonly ttsSynthesis: RemoteProviderSettings;
}

export interface RemoteProviderSettingsResponse {
  readonly settings: RemoteProviderSettingsBundle;
  readonly catalog: RemoteProviderCatalog;
  readonly secretStatuses: ProviderSecretStatus[];
}

export interface RemoteProviderSecretResponse {
  readonly status?: ProviderSecretStatus;
  readonly catalog?: RemoteProviderCatalog;
  readonly secretStatuses?: ProviderSecretStatus[];
}

export interface EnqueueAnalysisJobInput {
  readonly bookId: string;
  readonly chapterId?: string;
  readonly chapterIds?: string[];
  readonly providerId?: string;
  readonly modelId?: string;
  readonly jobType?: ProviderJobType;
  readonly discoveredGraph?: unknown;
  readonly sourceContext?: JsonRecord;
  readonly force?: boolean;
}

export type GetBookAIWorkflowPlanOptions = BookAIWorkflowPlanOptions;

export interface RemoteBookAIWorkflowJob {
  readonly id: string;
  readonly workflowId: string;
  readonly providerJobId: string;
  readonly stage: string;
  readonly planItemId: string;
  readonly sequence: number;
  readonly job?: RemoteProviderJob;
  readonly createdAt: string;
}

export interface RemoteBookAIWorkflow {
  readonly id: string;
  readonly novelId: string;
  readonly workflowType: string;
  readonly workflowDefinitionId: ExtensionContributionId;
  readonly workflowVersion: string;
  readonly providerId: string;
  readonly modelId?: string;
  readonly planHash: string;
  readonly plan: BookAIWorkflowPlan;
  readonly status: string;
  readonly stage: string;
  readonly progress?: JsonValue;
  readonly jobs: RemoteBookAIWorkflowJob[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

export interface StartBookAIWorkflowInput {
  readonly bookId: string;
  readonly workflowDefinitionId: ExtensionContributionId;
  readonly workflowVersion: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly planOptions?: BookAIWorkflowPlanOptions;
  readonly force?: boolean;
}
