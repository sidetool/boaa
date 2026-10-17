import {
  BOAA_ANALYSIS_WORKFLOW_SCHEMA_VERSION,
  BOAA_EXTENSION_API_VERSION,
  BOAA_EXTENSION_MANIFEST_VERSION,
  type ExtensionManifestV1,
} from '@boaa/extension-contracts';
import type { TrustedAnalysisWorkflowHostContext } from '../analysis-workflow-host-context';
import type { TrustedReaderAddonHostContext } from '../reader-addon-host-context';
import type { TrustedExtensionDefinition } from '../trusted-extension-registry';

export const CHARACTER_BUNDLE_ANALYSIS_EXTENSION_ID = 'boaa.ai.analysis' as const;
export const CHARACTER_BUNDLE_ANALYSIS_WORKFLOW_ID = 'moya.ai.analysis.character-bundle' as const;

const manifest = {
  manifestVersion: BOAA_EXTENSION_MANIFEST_VERSION,
  id: CHARACTER_BUNDLE_ANALYSIS_EXTENSION_ID,
  name: 'BOAA character analysis',
  version: '1.0.0',
  engine: { boaaApi: BOAA_EXTENSION_API_VERSION },
  permissions: ['analysis.workflow.execute'],
  contributes: {
    analysisWorkflows: [
      {
        id: CHARACTER_BUNDLE_ANALYSIS_WORKFLOW_ID,
        schemaVersion: BOAA_ANALYSIS_WORKFLOW_SCHEMA_VERSION,
        title: '묶음 인물 분석',
        description: '현재 화부터 이어지는 화에서 인물과 관계 후보를 준비합니다.',
        target: 'chapter-bundle',
        order: 100,
      },
    ],
  },
} as const satisfies ExtensionManifestV1;

export const characterBundleAnalysisTrustedExtension: TrustedExtensionDefinition<
  TrustedReaderAddonHostContext,
  TrustedAnalysisWorkflowHostContext
> = {
  manifest,
  activate(context) {
    return context.analysisWorkflows.register(CHARACTER_BUNDLE_ANALYSIS_WORKFLOW_ID, {
      isEnabled: ({ characterBundleAnalysis }) => characterBundleAnalysis.enabled,
      run: ({ characterBundleAnalysis }) => characterBundleAnalysis.run(),
    });
  },
};
