import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { PlatformManifest } from '@boaa/extension-contracts/platform-package';
import {
  declaredPluginGrants,
  pluginCapabilities,
  pluginCapabilityWarnings,
  pluginConnectionAccess,
  pluginContributionLabel,
  pluginFaultText,
  pluginHomeSectionTitles,
} from './plugin-presentation';

const fixture = vi.hoisted(() => ({
  manifest: {
    packageFormat: 'boaa.extension.package',
    packageVersion: 3,
    apiVersion: 2,
    extension: { id: 'fixture.catalog', name: '추천 작품', version: '1.0.0' },
    license: 'MIT',
    entries: {
      controller: { path: 'dist/controller.js', permissions: ['home.feed', 'http.request', 'storage.own'] },
      ui: { path: 'dist/ui.js', permissions: ['ui.render', 'http.request'] },
    },
    activation: ['onAppSession'],
    features: { required: ['home.feed', 'http.request', 'storage.own', 'ui.views'], optional: [] },
    contributes: {
      commands: [],
      views: ['settings'],
      decorations: [],
      connections: ['catalog'],
      homeSections: [{ id: 'today', title: '오늘의 추천' }],
    },
    requestedAccess: { storageKiB: 64, contentScopes: [] },
    connections: [{ id: 'catalog', title: '작품 서비스', endpoint: 'https://catalog.example/', methods: ['GET'] }],
  },
}));
vi.mock('./PlatformPluginProvider', () => ({
  useProductPlugins: () => ({ session: { instanceId: 'test', off: false }, message: '', retry() {} }),
}));
vi.mock('./use-platform-plugin-settings-model', () => ({
  usePlatformPluginSettingsModel: () => ({
    rows: [],
    faults: [],
    busy: false,
    preserve: false,
    review: { manifest: fixture.manifest, expectedRevision: 0, digest: 'test', pluginId: 'fixture.catalog' },
  }),
}));
import { PlatformPluginSettings } from './PlatformPluginSettings';

it('presents capabilities once while retaining the exact permissions of each entry', () => {
  const manifest = fixture.manifest as PlatformManifest;
  const grants = declaredPluginGrants(manifest);
  expect(grants).toEqual({
    controller: ['home.feed', 'http.request', 'storage.own'],
    ui: ['ui.render', 'http.request'],
  });
  grants.controller!.push('settings.own');
  expect(manifest.entries.controller!.permissions).not.toContain('settings.own');
  expect(pluginCapabilities(manifest).filter((group) => group.title === '외부 서비스 연결')).toHaveLength(1);
});

it('offers one install confirmation with human capabilities and account persistence', () => {
  const html = renderToStaticMarkup(<PlatformPluginSettings />);
  expect(html).toContain('확인하고 설치');
  expect(html).toContain('홈에 작품 표시');
  expect(html).toContain('외부 서비스 연결');
  expect(html).toContain('설정과 데이터 저장');
  expect(html).toContain('https://catalog.example/');
  expect(html).toContain('홈에 추가되는 목록: 오늘의 추천');
  expect(html).toContain('가져오기만');
  expect(html).toContain('이 서버의 내 계정에 설치됩니다.');
  expect(html).not.toContain('type="checkbox"');
  expect(html).not.toContain('JS 플러그인');
  expect(html).not.toContain('controller 권한');
});

it('uses distinct readable labels instead of exposing implementation identifiers', () => {
  expect(pluginContributionLabel('command', 'internal.job', ['internal.job'])).toBe('기능 실행');
  expect(pluginContributionLabel('view', 'internal.panel', ['internal.panel', 'other.panel'])).toBe('플러그인 화면 1');
});

it('describes home lists, risky combinations, network access and stops in plain language', () => {
  const manifest = fixture.manifest as PlatformManifest;
  expect(pluginHomeSectionTitles(manifest)).toEqual(['오늘의 추천']);
  expect(pluginHomeSectionTitles(undefined)).toEqual([]);
  expect(pluginCapabilityWarnings(manifest)).toEqual([]);
  const reading = {
    ...manifest,
    entries: { controller: { path: 'dist/controller.js', permissions: ['http.request', 'reader.content.visible'] } },
  } as PlatformManifest;
  expect(pluginCapabilityWarnings(reading)).toEqual(['읽는 책의 본문을 외부 서비스로 보낼 수 있어요.']);
  expect(pluginConnectionAccess(['GET', 'HEAD'])).toBe('가져오기만');
  expect(pluginConnectionAccess(['GET', 'POST'])).toBe('가져오기와 보내기');
  expect(pluginFaultText('WATCHDOG_TIMEOUT')).toBe('응답이 너무 늦어 멈췄어요.');
  expect(pluginFaultText('WORKER_ERROR')).not.toContain('WORKER_ERROR');
});
