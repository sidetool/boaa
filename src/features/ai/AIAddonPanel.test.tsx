import { renderToStaticMarkup } from 'react-dom/server';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AnalysisReviewWorkspace } from './AnalysisReviewWorkspace';
import { describe, expect, it, vi } from 'vitest';
import AIAddonPanel, {
  type AIAddonPanelActions,
  type AIAddonPanelController,
  type AIAddonPanelData,
} from './AIAddonPanel';
import { AIWorkflowPanel } from './AIWorkflowPanel';
import type { ChapterLabelAnalysisReviewArtifact } from '../../providers/analysis-review';

function analysisReview(): ChapterLabelAnalysisReviewArtifact {
  return {
    id: 'analysis-review-1',
    workflowId: 'workflow-1',
    providerJobId: 'job-1',
    inputRevisionId: 'input-1',
    stagingArtifactId: 'staging-1',
    reviewKind: 'chapter_labeling',
    windowId: 'window-1',
    chapterId: 'chapter-1',
    chapter: { title: '1화' },
    paragraphs: [
      {
        id: 'paragraph-1',
        novelId: 'book-1',
        chapterId: 'chapter-1',
        index: 0,
        text: '"안녕하세요."',
        startOffsetInChapter: 0,
        endOffsetInChapter: 8,
        textHash: 'paragraph-hash',
      },
    ],
    haloParagraphs: [],
    characterOptions: [],
    candidate: {
      characters: [],
      segments: [
        {
          id: 'segment-1',
          novelId: 'book-1',
          chapterId: 'chapter-1',
          paragraphId: 'paragraph-1',
          segmentIndex: 0,
          startOffset: 0,
          endOffset: 8,
          segmentTextHash: 'invalid-hash',
          type: 'quoted_dialogue',
          speakerId: 'unknown',
          candidateSpeakers: [],
          listenerIds: [],
          emotion: 'neutral',
          confidence: 0.5,
          isUserCorrected: false,
        },
      ],
    },
    validationIssues: [],
    qualityIssues: [],
    validationSummary: { errorCount: 0, warningCount: 0, issueCodes: [] },
    qualitySummary: { errorCount: 0, warningCount: 0, issueCodes: [] },
    status: 'editing',
    reviewRevision: 2,
  } as unknown as ChapterLabelAnalysisReviewArtifact;
}

function data(showDeveloperTools: boolean): AIAddonPanelData {
  return {
    workflow: {
      stageLabel: '검토 필요',
      graphBundleCount: 3,
      labelingWindowCount: 7,
      succeededJobCount: 5,
      pendingJobCount: 1,
      failedJobCount: 1,
      workflow: {
        status: 'needs_review',
        stage: 'needs_review',
        jobCount: 7,
        modelId: 'labeler-v1',
      },
      compactSpeaker: {
        contractId: 'speaker-attribution-workflow-v3',
        requestProfileId: 'speaker-attribution-v3-compact',
        stage: 'review',
        stageLabel: '검토 항목 분류',
        targetSpanCount: 18,
        sceneRequestCount: 3,
        escalationCapLabel: '최대 15% / 4개',
        riskSummaries: [
          { riskClass: 'boundary', label: '대화 경계', targetSpanCount: 2 },
          { riskClass: 'semantic', label: '의미 모호성', targetSpanCount: 1 },
        ],
      },
      labelVoiceReadiness: {
        ok: false,
        segmentCount: 42,
        missingParagraphCount: 2,
        missingVoiceCount: 1,
        unknownPercent: 18,
      },
      cacheReadiness: {
        ok: false,
        cachedSegmentCount: 12,
        cacheableSegmentCount: 42,
        missingCachedSegmentCount: 30,
        cacheItemCount: 12,
        cachedByteSizeLabel: '2 MB',
      },
      labelVoiceReady: false,
      cacheReady: false,
      reviewItems: [
        {
          id: 'review-1',
          kind: 'missing_paragraph_labels',
          severity: 'error',
          title: '라벨이 없는 예정 문단',
          detail: '2개 예정 문단의 화자/감정 라벨이 비어 있습니다.',
          recommendedAction: 'retry_workflow',
          actionLabel: '누락 라벨 재생성',
        },
      ],
      reviewWorkspace: {
        available: false,
        reviews: [],
        loading: false,
      },
      workflowRuntime: 'hosted',
      retryDisabled: false,
      cancelDisabled: false,
      startDisabled: true,
      refreshDisabled: false,
      warmupDisabled: true,
      cacheRefreshDisabled: true,
    },
    analysis: {
      showDeveloperTools,
      desktopProviderMode: false,
      desktopAnalysisDisabled: true,
      remoteAnalysisDisabled: false,
      labelRepairDisabled: false,
      graphMergeDisabled: true,
      segmentCount: 42,
      bundleStatusLabel: '후보 4명 · 관계 3개',
      providerStatusLabel: 'OpenAI',
      providers: [],
      workflows: [
        {
          id: 'test.ai.character-bundle',
          schemaVersion: 1,
          title: '등록된 묶음 분석',
          description: '후보 그래프를 준비합니다.',
          target: 'chapter-bundle',
          order: 100,
          disabled: false,
        },
      ],
    },
    correction: {
      segmentCount: 42,
      reviewItems: [],
      readerMode: 'analysis',
      characters: [],
      speakerDraft: 'unknown',
      speakerOptions: [],
      candidateSpeakerOptions: [],
      emotionDraft: 'neutral',
      emotionOptions: ['neutral'],
      scope: 'chapter',
    },
  };
}

function actions(): AIAddonPanelActions {
  return {
    workflow: {
      retry: vi.fn(),
      cancel: vi.fn(),
      start: vi.fn(),
      refresh: vi.fn(),
      warmupBookCache: vi.fn(),
      refreshCacheReadiness: vi.fn(),
      runReviewAction: vi.fn(),
      refreshReviews: vi.fn(),
      saveReviewDraft: vi.fn(),
      approveReview: vi.fn(),
      rejectReview: vi.fn(),
    },
    analysis: {
      runMock: vi.fn(),
      runDesktop: vi.fn(),
      runRemote: vi.fn(),
      repairLabels: vi.fn(),
      runWorkflow: vi.fn(),
      mergeGraph: vi.fn(),
    },
    graphReview: { toggleCandidate: vi.fn() },
    correction: {
      selectSegment: vi.fn(),
      setReaderMode: vi.fn(),
      setSpeakerDraft: vi.fn(),
      setEmotionDraft: vi.fn(),
      setScope: vi.fn(),
      apply: vi.fn(),
      close: vi.fn(),
    },
  };
}

function controller(): AIAddonPanelController {
  return {
    providerSettings: {
      available: false,
      loading: false,
      secretStatuses: [],
      secretDrafts: {},
      desktopMode: false,
      analysisRunning: false,
      hostedTTSBusy: false,
      updateDraft: vi.fn(),
      updateSecretDraft: vi.fn(),
      refresh: vi.fn(),
      saveSettings: vi.fn(),
      saveSecret: vi.fn(),
      deleteSecret: vi.fn(),
      testSecret: vi.fn(),
      runDesktopLLMSample: vi.fn(),
      playDesktopTTSSample: vi.fn(),
    },
  };
}

function panel(panelData: AIAddonPanelData) {
  const panelActions = actions();
  const descriptor = {
    id: 'test.ai.book-preparation' as const,
    schemaVersion: 1 as const,
    title: '기본 AI 보조 TTS',
    description: '작품 화자와 음성 연결을 준비합니다.',
    target: 'book' as const,
    kind: 'managed' as const,
  };
  return (
    <AIAddonPanel
      data={panelData}
      actions={panelActions}
      controller={controller()}
      managedWorkflow={{
        active: descriptor,
        options: [descriptor],
        surface: <AIWorkflowPanel data={panelData.workflow} actions={panelActions.workflow} />,
        usedFallback: false,
        switchDisabled: false,
        select: vi.fn(),
      }}
    />
  );
}

describe('AIAddonPanel', () => {
  it('keeps one recommended action visible and moves diagnostics behind advanced information', () => {
    const markup = renderToStaticMarkup(panel(data(false)));

    expect(markup).toContain('작품 분석');
    expect(markup).toContain('검토가 필요한 항목 1개가 있습니다.');
    expect(markup).toContain('분석 다시 시도');
    expect(markup.match(/class="primary-btn wide ai-recommended-action"/g)).toHaveLength(1);
    expect(markup).toContain('<summary>고급 정보</summary>');
    expect(markup).not.toContain('<details class="ai-advanced-disclosure" open="">');
    expect(markup).toContain('3</strong> 인물 관계 분석 묶음');
    expect(markup).toContain('7</strong> 화자 분석 구간');
    expect(markup).toContain('화자·음성 연결 검토 필요');
    expect(markup).toContain('화자 분리 · 검토 항목 분류');
    expect(markup).toContain('speaker-attribution-workflow-v3');
    expect(markup).toContain('대상 구간 18');
    expect(markup).toContain('장면 요청 3');
    expect(markup).toContain('재판별 한도 최대 15% / 4개');
    expect(markup).toContain('대화 경계 2');
    expect(markup).toContain('의미 모호성 1');
    expect(markup).toContain('aria-label="분석 검토 항목"');
    expect(markup).toContain('라벨이 없는 예정 문단');
    expect(markup).toContain('후보 4명 · 관계 3개');
    expect(markup).toContain('data-workflow-id="test.ai.character-bundle"');
    expect(markup).toContain('등록된 묶음 분석');
    expect(markup).toContain('data-workflow-id="test.ai.book-preparation"');
    expect(markup).not.toContain('AI 분석 방식');
    expect(markup).not.toContain('세밀한 화자 분리');
  });

  it('keeps the local Mock control hidden when developer tools are disabled', () => {
    const productionMarkup = renderToStaticMarkup(panel(data(false)));
    const developmentMarkup = renderToStaticMarkup(panel(data(true)));

    expect(productionMarkup).not.toContain('로컬 Mock');
    expect(developmentMarkup).toContain('로컬 Mock');
  });

  it('keeps the compact speaker status absent for legacy workflows', () => {
    const panelData = data(false);
    const markup = renderToStaticMarkup(
      panel({
        ...panelData,
        workflow: { ...panelData.workflow, compactSpeaker: undefined },
      }),
    );

    expect(markup).not.toContain('aria-label="화자 분리 진행 상태"');
    expect(markup).not.toContain('speaker-attribution-workflow-v3');
  });

  it('renders the durable failed-window review workspace', () => {
    const panelData = data(false);
    const markup = renderToStaticMarkup(
      panel({
        ...panelData,
        workflow: {
          ...panelData.workflow,
          reviewWorkspace: { available: true, reviews: [analysisReview()], loading: false },
        },
      }),
    );

    expect(markup).toContain('분석이 멈춘 구간 검토');
    expect(markup).toContain('&quot;안녕하세요.&quot;');
    expect(markup).toContain('저장 및 재검증');
    expect(markup).toContain('승인 및 재개');
    expect(markup).toContain('수정 적용 범위');
    expect(markup).toContain('이 구간부터 다시 분석');
    expect(markup).toContain('따옴표 대사');
    expect(markup).toContain('떨리는 목소리');
    expect(markup).not.toContain('수정 내용을 후속 분석에 반영하는 연결이 완료되기 전에는');
  });

  it('selects listeners by name, keeps a draft on refresh and saves the original character ids', () => {
    const review = analysisReview();
    const artifact = {
      ...review,
      editIntents: {},
      characterOptions: [{ id: 'character-9', canonicalName: '은영', aliases: [] }],
      candidate: {
        ...review.candidate,
        segments: review.candidate.segments.map((segment) => ({
          ...segment,
          listenerIds: ['legacy-person'],
          emotion: '기존 감정',
        })),
      },
    };
    const callbacks = actions().workflow;
    const render = (value: ChapterLabelAnalysisReviewArtifact) => (
      <AnalysisReviewWorkspace data={{ available: true, loading: false, reviews: [value] }} actions={callbacks} />
    );
    let view!: ReactTestRenderer;
    act(() => {
      view = create(render(artifact));
    });
    try {
      const picker = () => view.root.findByProps({ 'aria-label': '대화 상대 추가' });
      expect(picker().findByProps({ value: 'character-9' }).children).toEqual(['은영']);
      act(() => picker().props.onChange({ currentTarget: { value: 'character-9' } }));
      act(() => view.update(render(structuredClone(artifact))));
      const selected = view.root.findByProps({ 'aria-label': '은영 대화 상대에서 제외' });
      expect(selected).toBeDefined();
      expect(picker().findAllByProps({ value: 'character-9' })).toHaveLength(0);
      act(() => view.root.findByProps({ 'aria-label': 'legacy-person 대화 상대에서 제외' }).props.onClick());
      act(() =>
        view.root
          .findAllByType('button')
          .find((btn) => btn.children.includes(' 저장 및 재검증'))!
          .props.onClick(),
      );
      expect(callbacks.saveReviewDraft).toHaveBeenCalledWith(
        artifact.id,
        expect.objectContaining({
          segments: [expect.objectContaining({ listenerIds: ['character-9'], emotion: '기존 감정' })],
        }),
        {},
      );
      act(() => view.update(render({ ...artifact, status: 'approved', reviewRevision: artifact.reviewRevision + 1 })));
      expect(view.root.findByType('fieldset').props.disabled).toBe(true);
      expect(view.root.findAllByProps({ 'aria-label': '은영 대화 상대에서 제외' })).toHaveLength(0);
    } finally {
      act(() => view.unmount());
    }
  });

  it('offers stored-result retry only after transient promotion retries are exhausted', () => {
    const panelData = data(false);
    const review = {
      ...analysisReview(),
      status: 'approved' as const,
      promotionLastErrorCode: 'promotion_transient_retry_exhausted',
    };
    const markup = renderToStaticMarkup(
      panel({
        ...panelData,
        workflow: {
          ...panelData.workflow,
          reviewWorkspace: { available: true, reviews: [review], loading: false },
        },
      }),
    );

    expect(markup).toContain('반영 차단됨');
    expect(markup).toContain('반영 다시 시도');
    expect(markup).toContain('외부 AI 요청은 발생하지 않고');
  });

  it('keeps core listening available when no managed workflow surface is registered', () => {
    const panelData = data(false);
    const markup = renderToStaticMarkup(
      <AIAddonPanel
        data={panelData}
        actions={actions()}
        controller={controller()}
        managedWorkflow={{ options: [], usedFallback: false, switchDisabled: false, select: vi.fn() }}
      />,
    );

    expect(markup).toContain('작품 분석');
    expect(markup).toContain('사용 불가');
    expect(markup).not.toContain('workflow 없음');
    expect(markup).toContain('일반 듣기와 시스템 음성은 계속 사용할 수 있습니다.');
    expect(markup).not.toContain('작품 전체 분석 시작');
  });

  it('blocks switching between official analysis methods while an execution is active', () => {
    const panelData = data(false);
    const panelActions = actions();
    const first = {
      id: 'test.ai.book-preparation' as const,
      schemaVersion: 1 as const,
      title: '기본 AI 보조 TTS',
      description: '작품 화자와 음성 연결을 준비합니다.',
      target: 'book' as const,
      kind: 'managed' as const,
    };
    const second = { ...first, id: 'test.ai.book-preparation-v2' as const, title: '다른 공식 분석' };

    const markup = renderToStaticMarkup(
      <AIAddonPanel
        data={panelData}
        actions={panelActions}
        controller={controller()}
        managedWorkflow={{
          active: first,
          options: [first, second],
          surface: <AIWorkflowPanel data={panelData.workflow} actions={panelActions.workflow} />,
          usedFallback: false,
          switchDisabled: true,
          switchDisabledReason: '진행 중인 분석을 취소하거나 완료한 뒤 변경할 수 있습니다.',
          select: vi.fn(),
        }}
      />,
    );

    expect(markup).toContain('AI 분석 방식');
    expect(markup).toContain('<select id="ai-managed-workflow" disabled=""');
    expect(markup).toContain('다른 공식 분석');
    expect(markup).toContain('진행 중인 분석을 취소하거나 완료한 뒤 변경할 수 있습니다.');
  });
});
