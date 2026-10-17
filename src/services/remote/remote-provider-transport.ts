import type { RemoteRequest } from './remote-api-contracts';
import type { ProviderSecretStatus, TTSCacheResolveInput, TTSCacheResolveResult } from '../../providers/provider-jobs';
import type { BookAIWorkflowPlan } from '../../providers/book-ai-workflow-plan';
import type { ChapterLabelAnalysisReviewArtifact } from '../../providers/analysis-review';
import type { AnalysisReviewEditIntentMap } from '../../providers/analysis-review-correction';
import type {
  RemoteProviderJob,
  RemoteProviderCatalog,
  RemoteProviderSettings,
  RemoteProviderSettingsResponse,
  RemoteProviderSecretResponse,
  EnqueueAnalysisJobInput,
  GetBookAIWorkflowPlanOptions,
  RemoteBookAIWorkflow,
  StartBookAIWorkflowInput,
} from './remote-provider-contracts';
import {
  mapServerProviderJob,
  mapServerBookAIWorkflow,
  mapServerTTSCacheItem,
  mapProviderSettings,
  mapProviderSettingsBundle,
} from './remote-provider-mappers';
type JsonRecord = Record<string, unknown>;

/** Endpoint contracts only; the client retains authentication, timeout and error handling. */
export class RemoteProviderTransport {
  constructor(private readonly request: RemoteRequest) {}
  listProviders(): Promise<RemoteProviderCatalog> {
    return this.request('/providers');
  }

  async getProviderSettings(): Promise<RemoteProviderSettingsResponse> {
    const response = await this.request<{
      settings: JsonRecord;
      catalog: RemoteProviderCatalog;
      secretStatuses?: ProviderSecretStatus[];
    }>('/provider-settings');
    return {
      settings: mapProviderSettingsBundle(response.settings),
      catalog: response.catalog,
      secretStatuses: response.secretStatuses ?? [],
    };
  }

  async saveProviderSettings(
    scope: RemoteProviderSettings['scope'],
    input: Partial<Omit<RemoteProviderSettings, 'scope' | 'updatedAt'>>,
  ): Promise<{
    settings: RemoteProviderSettings;
    catalog: RemoteProviderCatalog;
    secretStatuses: ProviderSecretStatus[];
  }> {
    const response = await this.request<{
      settings: JsonRecord;
      catalog: RemoteProviderCatalog;
      secretStatuses?: ProviderSecretStatus[];
    }>(`/provider-settings/${encodeURIComponent(scope)}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    });
    return {
      settings: mapProviderSettings(response.settings),
      catalog: response.catalog,
      secretStatuses: response.secretStatuses ?? [],
    };
  }

  async saveProviderSecret(
    scope: RemoteProviderSettings['scope'],
    providerId: string,
    secretName: string,
    secretValue: string,
  ): Promise<RemoteProviderSecretResponse> {
    return this.request(
      `/provider-secrets/${encodeURIComponent(scope)}/${encodeURIComponent(providerId)}/${encodeURIComponent(secretName)}`,
      {
        method: 'PUT',
        body: JSON.stringify({ secretValue }),
      },
    );
  }

  async deleteProviderSecret(
    scope: RemoteProviderSettings['scope'],
    providerId: string,
    secretName: string,
  ): Promise<RemoteProviderSecretResponse> {
    return this.request(
      `/provider-secrets/${encodeURIComponent(scope)}/${encodeURIComponent(providerId)}/${encodeURIComponent(secretName)}`,
      {
        method: 'DELETE',
      },
    );
  }

  async testProviderSecret(
    scope: RemoteProviderSettings['scope'],
    providerId: string,
    secretName: string,
  ): Promise<RemoteProviderSecretResponse & { ok?: true; message?: string }> {
    return this.request(
      `/provider-secrets/${encodeURIComponent(scope)}/${encodeURIComponent(providerId)}/${encodeURIComponent(secretName)}/test`,
      {
        method: 'POST',
      },
    );
  }

  async listTTSProviderVoices(
    providerId: string,
  ): Promise<{ voices: Array<{ id: string; label: string; lang: string }> }> {
    return this.request(`/tts-providers/${encodeURIComponent(providerId)}/voices`);
  }

  getBookAIWorkflowPlan(
    bookId: string,
    options: GetBookAIWorkflowPlanOptions = {},
  ): Promise<{ plan: BookAIWorkflowPlan }> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(options)) {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        params.set(key, String(Math.floor(value)));
      }
    }
    const search = params.toString();
    return this.request(`/books/${encodeURIComponent(bookId)}/analysis-workflow-plan${search ? `?${search}` : ''}`);
  }

  async startBookAIWorkflow(input: StartBookAIWorkflowInput): Promise<{ workflow: RemoteBookAIWorkflow }> {
    const response = await this.request<{ workflow: JsonRecord }>(
      `/books/${encodeURIComponent(input.bookId)}/analysis-workflows`,
      {
        method: 'POST',
        body: JSON.stringify({
          providerId: input.providerId,
          modelId: input.modelId,
          workflowDefinitionId: input.workflowDefinitionId,
          workflowVersion: input.workflowVersion,
          planOptions: input.planOptions,
          force: input.force,
        }),
      },
    );
    return { workflow: mapServerBookAIWorkflow(response.workflow) };
  }

  async getBookAIWorkflow(workflowId: string, signal?: AbortSignal): Promise<{ workflow: RemoteBookAIWorkflow }> {
    const response = await this.request<{ workflow: JsonRecord }>(
      `/analysis-workflows/${encodeURIComponent(workflowId)}`,
      { signal },
    );
    return { workflow: mapServerBookAIWorkflow(response.workflow) };
  }

  listBookAIWorkflowReviews(
    workflowId: string,
    signal?: AbortSignal,
  ): Promise<{ reviews: ChapterLabelAnalysisReviewArtifact[] }> {
    return this.request(`/analysis-workflows/${encodeURIComponent(workflowId)}/reviews`, { signal });
  }

  getAnalysisReviewArtifact(
    reviewId: string,
    signal?: AbortSignal,
  ): Promise<{ review: ChapterLabelAnalysisReviewArtifact }> {
    return this.request(`/analysis-review-artifacts/${encodeURIComponent(reviewId)}`, { signal });
  }

  saveAnalysisReviewDraft(
    reviewId: string,
    input: {
      expectedReviewRevision: number;
      candidate: ChapterLabelAnalysisReviewArtifact['candidate'];
      editIntents?: AnalysisReviewEditIntentMap;
    },
    signal?: AbortSignal,
  ): Promise<{ review: ChapterLabelAnalysisReviewArtifact }> {
    return this.request(`/analysis-review-artifacts/${encodeURIComponent(reviewId)}/decisions`, {
      method: 'POST',
      body: JSON.stringify({ action: 'save_draft', ...input }),
      signal,
    });
  }

  rejectAnalysisReviewArtifact(
    reviewId: string,
    input: { expectedReviewRevision: number; reason?: string },
    signal?: AbortSignal,
  ): Promise<{ review: ChapterLabelAnalysisReviewArtifact }> {
    return this.request(`/analysis-review-artifacts/${encodeURIComponent(reviewId)}/decisions`, {
      method: 'POST',
      body: JSON.stringify({ action: 'reject', ...input }),
      signal,
    });
  }

  approveAnalysisReviewArtifact(
    reviewId: string,
    expectedReviewRevision: number,
    signal?: AbortSignal,
  ): Promise<{ review: ChapterLabelAnalysisReviewArtifact }> {
    return this.request(`/analysis-review-artifacts/${encodeURIComponent(reviewId)}/decisions`, {
      method: 'POST',
      body: JSON.stringify({ action: 'approve', expectedReviewRevision }),
      signal,
    });
  }

  async retryBookAIWorkflow(workflowId: string, signal?: AbortSignal): Promise<{ workflow: RemoteBookAIWorkflow }> {
    const response = await this.request<{ workflow: JsonRecord }>(
      `/analysis-workflows/${encodeURIComponent(workflowId)}/retry`,
      {
        method: 'POST',
        body: JSON.stringify({ action: 'retry_same_request' }),
        signal,
      },
    );
    return { workflow: mapServerBookAIWorkflow(response.workflow) };
  }

  async cancelBookAIWorkflow(workflowId: string, signal?: AbortSignal): Promise<{ workflow: RemoteBookAIWorkflow }> {
    const response = await this.request<{ workflow: JsonRecord }>(
      `/analysis-workflows/${encodeURIComponent(workflowId)}/cancel`,
      {
        method: 'POST',
        signal,
      },
    );
    return { workflow: mapServerBookAIWorkflow(response.workflow) };
  }

  async refreshBookAIWorkflowTTSCacheReadiness(
    workflowId: string,
    signal?: AbortSignal,
  ): Promise<{ workflow: RemoteBookAIWorkflow }> {
    const response = await this.request<{ workflow: JsonRecord }>(
      `/analysis-workflows/${encodeURIComponent(workflowId)}/tts-cache-readiness`,
      { method: 'POST', signal },
    );
    return { workflow: mapServerBookAIWorkflow(response.workflow) };
  }

  async enqueueAnalysisJob(input: EnqueueAnalysisJobInput): Promise<{ job: RemoteProviderJob }> {
    const response = await this.request<{ job: JsonRecord }>(
      `/books/${encodeURIComponent(input.bookId)}/analysis-jobs`,
      {
        method: 'POST',
        body: JSON.stringify({
          chapterId: input.chapterId,
          chapterIds: input.chapterIds,
          providerId: input.providerId,
          modelId: input.modelId,
          jobType: input.jobType,
          discoveredGraph: input.discoveredGraph,
          sourceContext: input.sourceContext,
          force: input.force,
        }),
      },
    );
    return { job: mapServerProviderJob(response.job) };
  }

  async getProviderJob(jobId: string, signal?: AbortSignal): Promise<{ job: RemoteProviderJob }> {
    const response = await this.request<{ job: JsonRecord }>(`/provider-jobs/${encodeURIComponent(jobId)}`, { signal });
    return { job: mapServerProviderJob(response.job) };
  }

  async cancelProviderJob(jobId: string, signal?: AbortSignal): Promise<{ job: RemoteProviderJob }> {
    const response = await this.request<{ job: JsonRecord }>(`/provider-jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: 'POST',
      signal,
    });
    return { job: mapServerProviderJob(response.job) };
  }

  async resolveTTSCache(
    chapterId: string,
    input: TTSCacheResolveInput,
    signal?: AbortSignal,
  ): Promise<TTSCacheResolveResult> {
    const response = await this.request<{
      cacheHit: boolean;
      cacheKey: string;
      optionsHash: string;
      cacheItem?: JsonRecord;
      job?: JsonRecord;
    }>(`/chapters/${encodeURIComponent(chapterId)}/tts-cache/resolve`, {
      method: 'POST',
      signal,
      body: JSON.stringify(input),
    });
    return {
      cacheHit: response.cacheHit,
      cacheKey: response.cacheKey,
      optionsHash: response.optionsHash,
      cacheItem: response.cacheItem ? mapServerTTSCacheItem(response.cacheItem) : undefined,
      job: response.job ? mapServerProviderJob(response.job) : undefined,
    };
  }
}
