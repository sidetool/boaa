import type { PlatformManifest } from '@boaa/extension-contracts/platform-package';
import type { RoleGrants } from './store-model';

export const PLUGIN_ACCOUNT_DESCRIPTION =
  '이 서버의 내 계정에 설치됩니다. 다른 기기에서도 같은 계정으로 로그인하면 플러그인과 설정을 사용할 수 있습니다.';

export type PluginCapabilityId = 'home' | 'network' | 'reader' | 'data' | 'interface';

const groups: { id: PluginCapabilityId; title: string; permissions: Record<string, string> }[] = [
  {
    id: 'home',
    title: '홈에 작품 표시',
    permissions: { 'home.feed': '홈에 작품 목록을 표시하고, 선택한 제목으로 검색합니다.' },
  },
  {
    id: 'network',
    title: '외부 서비스 연결',
    permissions: {
      'http.request': '승인한 서비스에서 자료를 가져오거나 보냅니다. 본문 읽기도 허용하면 본문을 전송할 수 있습니다.',
    },
  },
  {
    id: 'reader',
    title: '읽기 보조',
    permissions: {
      'reader.content.visible': '현재 보이는 본문을 읽습니다.',
      'reader.content.book': '현재 열린 책 전체 본문을 읽습니다.',
      'reader.state': '현재 읽는 위치와 화면 상태를 확인합니다.',
      'reader.decorations': '본문에 색상과 서식을 표시합니다.',
      'reader.input': '사용자가 연결한 길게 누르기 입력을 받습니다.',
      'reader.control': '허용한 입력을 누르는 동안 자동 스크롤을 조절합니다.',
      'reader.annotations.read': '현재 책의 북마크·하이라이트·메모를 읽습니다.',
      'reader.annotations.write':
        '현재 책의 북마크·하이라이트·메모를 만들고 변경하거나 삭제합니다. 변경 내용은 플러그인을 꺼도 남습니다.',
    },
  },
  {
    id: 'data',
    title: '설정과 데이터 저장',
    permissions: {
      'settings.own': '이 플러그인의 설정을 저장하고 변경합니다.',
      'storage.own': '이 플러그인의 자료를 전용 저장 공간에 보관합니다.',
    },
  },
  {
    id: 'interface',
    title: '플러그인 화면과 기능',
    permissions: {
      'app.search': '선택한 제목으로 BOAA 검색 화면을 엽니다.',
      'ui.render': '플러그인 화면을 표시합니다.',
      'commands.register': '사용자가 실행할 수 있는 기능을 추가합니다.',
    },
  },
];

/** Presentation may merge duplicate capabilities; authority must retain each entry's exact grants. */
export function declaredPluginGrants(manifest: PlatformManifest): RoleGrants {
  return Object.fromEntries(Object.entries(manifest.entries).map(([role, entry]) => [role, [...entry.permissions]]));
}

export function pluginCapabilities(manifest: PlatformManifest) {
  const requested = new Set<string>(Object.values(manifest.entries).flatMap((entry) => entry.permissions));
  return groups
    .map((group) => ({
      id: group.id,
      title: group.title,
      details: Object.entries(group.permissions)
        .filter(([permission]) => requested.has(permission))
        .map(([, label]) => label),
    }))
    .filter((group) => group.details.length);
}

/** Combinations worth calling out before consent, beyond the per-capability list. */
export function pluginCapabilityWarnings(manifest: PlatformManifest) {
  const requested = new Set<string>(Object.values(manifest.entries).flatMap((entry) => entry.permissions));
  const warnings: string[] = [];
  if (
    requested.has('http.request') &&
    (requested.has('reader.content.visible') || requested.has('reader.content.book'))
  )
    warnings.push('읽는 책의 본문을 외부 서비스로 보낼 수 있어요.');
  return warnings;
}

export function pluginHomeSectionTitles(manifest: PlatformManifest | undefined) {
  return manifest?.contributes.homeSections?.map((section) => section.title) ?? [];
}

/** Read-only access reads differently from access that can change things on the other side. */
export function pluginConnectionAccess(methods: readonly string[]) {
  return methods.every((method) => ['GET', 'HEAD', 'OPTIONS'].includes(method)) ? '가져오기만' : '가져오기와 보내기';
}

/** Runtime stop codes stay available for support, but the sentence leads. */
export function pluginFaultText(code: string) {
  if (code === 'CONFIG_CHANGED') return '설정이 바뀌어 읽기 기능을 멈췄어요.';
  if (code.endsWith('TIMEOUT')) return '응답이 너무 늦어 멈췄어요.';
  return '오류가 나서 멈췄어요.';
}

export function pluginContributionLabel(kind: 'command' | 'view' | 'connection', id: string, ids: readonly string[]) {
  const common: Record<string, string> = {
    settings: '설정 화면',
    preferences: '설정 화면',
    refresh: '새로고침',
    search: '작품 찾기',
  };
  if (kind !== 'connection' && common[id]) return common[id];
  const label = kind === 'command' ? '기능 실행' : kind === 'view' ? '플러그인 화면' : '외부 서비스';
  return ids.length > 1 ? `${label} ${ids.indexOf(id) + 1}` : label;
}
