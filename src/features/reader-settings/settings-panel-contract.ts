import {
  Hand,
  Info,
  HardDrive,
  Network,
  Palette,
  PlugZap,
  Puzzle,
  RefreshCw,
  Type,
  type LucideIcon,
} from 'lucide-react';
import { type ReactNode } from 'react';
import type { GestureBindings, ReadingProfile, ReadingProfileOverride } from '../../domain/types';
import type { PlatformRuntimeInfo, ProviderExecutionRuntimeKind } from '../../platform/runtime';
import type { ReaderPersonalizationRepository } from '../../repositories/reader-personalization-repository';
import type { ExtensionContributionId } from '@boaa/extension-contracts';
import type { AppExtensionSnapshot } from '../../extensions/app-extension-manager';
import type { BookEnrichmentAutomationController } from '../book-enrichment/useBookEnrichmentAutomation';
import type { SelfHostAccount } from '../auth/self-host-auth-client';
import type { WebNovelMetadataCollectorBroker } from '../../services/webnovel-metadata-collector-broker';
import type { ExternalSourceController } from '../external-sources/useExternalSourceController';
import type { StorageSettingsProps } from './StorageSettingsPanel';
import type { ReaderSettingsController } from './useReaderSettingsDraft';

export type SettingsTab =
  | 'appearance'
  | 'layout'
  | 'gesture'
  | 'sources'
  | 'extensions'
  | 'storage'
  | 'downloads'
  | 'sync'
  | 'remote-access'
  | 'application';

interface SettingsSection {
  readonly id: SettingsTab;
  readonly label: string;
  readonly detail: string;
  readonly icon: LucideIcon;
}

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    id: 'appearance',
    label: '모양',
    detail: '시작 화면, 앱 테마',
    icon: Palette,
  },
  {
    id: 'layout',
    label: '리더 보기',
    detail: '글자, 여백, 읽기 방식',
    icon: Type,
  },
  {
    id: 'gesture',
    label: '리더 조작',
    detail: '탭, 스와이프, 화면 유지',
    icon: Hand,
  },
  {
    id: 'sources',
    label: '콘텐츠 소스',
    detail: '연결, 패키지, 다운로드',
    icon: PlugZap,
  },
  {
    id: 'extensions',
    label: '기능 확장',
    detail: '부가 기능, 권한',
    icon: Puzzle,
  },
  { id: 'storage', label: '저장공간', detail: '사용량, 백업, 다운로드', icon: HardDrive },
  {
    id: 'sync',
    label: '동기화',
    detail: '연결, 동기화 상태',
    icon: RefreshCw,
  },
  {
    id: 'remote-access',
    label: '원격 접속',
    detail: '다른 기기 연결, 접속 주소',
    icon: Network,
  },
  {
    id: 'application',
    label: '앱 정보',
    detail: '버전, 환경, 라이선스',
    icon: Info,
  },
];

export interface ReaderSettingsPanelProps {
  readonly controller: ReaderSettingsController;
  readonly profile: ReadingProfile;
  readonly bookOverrideEnabled: boolean;
  readonly contrastWarning: boolean;
  readonly gestureBindings: GestureBindings;
  readonly personalizationRepository?: ReaderPersonalizationRepository;
  readonly platformRuntime: PlatformRuntimeInfo;
  readonly providerExecutionRuntime: ProviderExecutionRuntimeKind;
  readonly serverApiBaseUrl?: string;
  readonly selfHostAccount?: SelfHostAccount;
  readonly logoutSelfHostAccount?: () => Promise<void>;
  readonly extensions: readonly AppExtensionSnapshot[];
  readonly installedPackages?: ReactNode;
  readonly externalSources: ExternalSourceController;
  readonly webNovelMetadataCollector?: WebNovelMetadataCollectorBroker;
  readonly bookEnrichmentAutomation?: BookEnrichmentAutomationController;
  readonly libraryCount?: number;
  readonly storage?: StorageSettingsProps;
  readonly initialTab?: SettingsTab;
  readonly updatesRequest?: number;
  readonly startupShelves?: readonly { id: string; name: string }[];
  readonly startupTabs?: readonly { id: string; title: string; hidden?: boolean }[];
  readonly syncContent?: ReactNode;
  readonly openSync: () => void;
  readonly openBackup: () => void;
  renderExtensionDetails?(extension: AppExtensionSnapshot): ReactNode;
  updateProfile(patch: ReadingProfileOverride): void;
  setBookOverrideEnabled(enabled: boolean): void;
  resetProfile(): void;
  updateGestureBindings(patch: Partial<GestureBindings>): void;
  setExtensionEnabled(extensionId: ExtensionContributionId, enabled: boolean): void;
}

export function saveStatusLabel(controller: ReaderSettingsController): string {
  if (controller.saveError) return '저장하지 못했습니다.';
  if (controller.saveStatus === 'saving') return '저장 중…';
  if (controller.isDirty) return '저장 대기 중…';
  return '자동 저장';
}
