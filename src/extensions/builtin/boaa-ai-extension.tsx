import {
  BOAA_ANALYSIS_WORKFLOW_SCHEMA_VERSION,
  BOAA_EXTENSION_API_VERSION,
  BOAA_EXTENSION_MANIFEST_VERSION,
  type ExtensionManifestV1,
} from '@boaa/extension-contracts';
import { AIWorkflowPanel } from '../../features/ai/AIWorkflowPanel';
import type { TrustedAnalysisWorkflowHostContext } from '../analysis-workflow-host-context';
import type { TrustedReaderAddonHostContext } from '../reader-addon-host-context';
import type { TrustedExtensionDefinition } from '../trusted-extension-registry';
import { BOOK_AI_TTS_WORKFLOW_ID } from './book-ai-tts-workflow-extension';
import { CHARACTER_BUNDLE_ANALYSIS_WORKFLOW_ID } from './character-bundle-analysis-extension';

export const BOAA_AI_EXTENSION_ID = 'boaa.ai' as const;
export const BOAA_AI_ADDON_ID = 'boaa.ai.panel' as const;

const manifest = {
  manifestVersion: BOAA_EXTENSION_MANIFEST_VERSION,
  id: BOAA_AI_EXTENSION_ID,
  name: 'BOAA AI',
  version: '1.0.0',
  engine: { boaaApi: BOAA_EXTENSION_API_VERSION },
  permissions: ['reader.addon.render', 'reader.context.read', 'analysis.workflow.execute'],
  contributes: {
    readerAddonTabs: [
      {
        id: BOAA_AI_ADDON_ID,
        label: 'AI',
        icon: 'wand',
        order: 60,
      },
    ],
    analysisWorkflows: [
      {
        id: CHARACTER_BUNDLE_ANALYSIS_WORKFLOW_ID,
        schemaVersion: BOAA_ANALYSIS_WORKFLOW_SCHEMA_VERSION,
        title: '묶음 인물 분석',
        description: '현재 화부터 이어지는 화에서 인물과 관계 후보를 준비합니다.',
        target: 'chapter-bundle',
        order: 100,
      },
      {
        id: BOOK_AI_TTS_WORKFLOW_ID,
        schemaVersion: BOAA_ANALYSIS_WORKFLOW_SCHEMA_VERSION,
        title: 'BOAA AI 분석',
        description: '작품을 분석해 화자 라벨과 캐릭터 음성 연결을 준비합니다.',
        target: 'book',
        kind: 'managed',
        order: 100,
      },
    ],
  },
} as const satisfies ExtensionManifestV1;

/** Official beta AI surfaces. System/basic TTS remains outside this extension. */
export const boaaAITrustedExtension: TrustedExtensionDefinition<
  TrustedReaderAddonHostContext,
  TrustedAnalysisWorkflowHostContext
> = {
  manifest,
  activate(context) {
    context.readerAddons.register(BOAA_AI_ADDON_ID, ({ aiPanel }) => aiPanel ?? null);
    context.analysisWorkflows.register(CHARACTER_BUNDLE_ANALYSIS_WORKFLOW_ID, {
      isEnabled: ({ characterBundleAnalysis }) => characterBundleAnalysis.enabled,
      run: ({ characterBundleAnalysis }) => characterBundleAnalysis.run(),
    });
    context.analysisWorkflows.register(BOOK_AI_TTS_WORKFLOW_ID, {
      isEnabled: ({ bookAITTS }) => Boolean(bookAITTS?.enabled),
      render: ({ bookAITTS }) =>
        bookAITTS ? <AIWorkflowPanel data={bookAITTS.data} actions={bookAITTS.actions} /> : null,
    });
  },
};
