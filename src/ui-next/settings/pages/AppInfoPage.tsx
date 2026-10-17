import { ExternalLink, FileScan, FileText, Images, LogOut, ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import packageMetadata from '../../../../package.json';
import { useOptionalAppRuntime } from '../../../app/runtime/RuntimeProvider';
import type { SelfHostAccount } from '../../../features/auth/self-host-auth-client';
import { useApplicationInfoSettingsModel } from '../../../features/reader-settings/use-application-info-settings-model';
import { remoteAccessAddress } from '../../../features/reader-settings/use-remote-access-settings-model';
import type { PlatformRuntimeInfo, ProviderExecutionRuntimeKind } from '../../../platform/runtime';
import { BrandWordmark } from '../../../shared/ui/BrandWordmark';
import { publicAssetUrl } from '../../../utils/public-asset-url';
import { Notice, Pref, PrefFold, PrefGroup, PrefSection } from '../../components/prefs';
import { AccessLinkCard } from './AccessLinkCard';

const ARCHIVE_PARTS = [
  {
    name: '7z-wasm 1.2.0',
    purpose: '암호 걸린 7z·CB7 열기',
    license: 'GNU LGPL 2.1 이상, unRAR 제한',
    source: 'https://github.com/use-strict/7z-wasm',
    licenseFile: '/third_party/licenses/common/LGPL-2.1.txt',
  },
  {
    name: 'node-unrar-js 2.0.2',
    purpose: 'RAR4·RAR5·CBR 열기',
    license: 'MIT 래퍼, unRAR 제한',
    source: 'https://github.com/YuJianrong/node-unrar.js',
  },
  {
    name: 'libarchive-wasm 1.2.0',
    purpose: '7z·CB7 목록과 이미지 꺼내기',
    license: 'MIT 래퍼, libarchive BSD-2-Clause와 코덱별 라이선스',
    source: 'https://github.com/ofk/libarchive-wasm',
  },
] as const;

function runtimeName(runtime: PlatformRuntimeInfo, android: boolean) {
  if (android) return 'Android 앱';
  if (runtime.kind === 'tauri-desktop') return '데스크톱 앱';
  if (runtime.kind === 'tauri-mobile') return '모바일 앱';
  return '웹 브라우저';
}

function voiceRuntime(kind: ProviderExecutionRuntimeKind) {
  if (kind === 'server') return '서버 작업자로 처리';
  if (kind === 'desktop') return '기기 보안 연결로 처리';
  return '시스템 음성만, 서버를 연결하면 더 쓸 수 있어요';
}

function OutLink({ href, title, help }: { href: string; title: ReactNode; help?: ReactNode }) {
  return (
    <a className="un-pref un-pref-link" href={href} target="_blank" rel="noreferrer">
      <span className="un-pref-text">
        <strong>{title}</strong>
        {help && <small>{help}</small>}
      </span>
      <ExternalLink size={16} className="un-pref-link-chevron" aria-hidden="true" />
    </a>
  );
}

/** 앱 정보: who is signed in, what this build can do here, formats, data and notices. */
export function AppInfoPage(props: {
  platformRuntime: PlatformRuntimeInfo;
  providerExecutionRuntime: ProviderExecutionRuntimeKind;
  selfHostAccount?: SelfHostAccount;
  logoutSelfHostAccount?: () => Promise<void>;
}) {
  const { webAccessUrl, isAndroid, mediaSessionAvailable } = useApplicationInfoSettingsModel(props.platformRuntime);
  const product = useOptionalAppRuntime()?.product;
  const StoragePanel = product?.StoragePanel;
  const desktop = props.platformRuntime.kind === 'tauri-desktop';
  const playback = isAndroid
    ? '백그라운드 재생, 알림·잠금 화면 조작'
    : desktop
      ? '미니 플레이어, 미디어 키'
      : mediaSessionAvailable
        ? '미니 플레이어, 브라우저 미디어 키'
        : '미니 플레이어 (미디어 키는 안 돼요)';
  const offline = isAndroid
    ? '기기에 저장, 끊긴 작업 이어서 받기'
    : desktop
      ? '음성 저장, 끊긴 항목 이어서 받기'
      : product
        ? '저장한 작품은 오프라인으로 읽기'
        : '서버 음성을 이 브라우저에 저장';
  const files = isAndroid ? 'Android 파일 선택' : desktop ? '기기 파일 열기·저장' : '브라우저 파일 선택·내보내기';
  const account = props.selfHostAccount;

  return (
    <>
      {StoragePanel && <StoragePanel />}

      <header className="un-about-hero">
        <img src={publicAssetUrl('/icons/boaa-192.png')} alt="" width={64} height={64} />
        <div>
          <BrandWordmark className="un-about-wordmark" />
          <p>텍스트·만화 뷰어</p>
        </div>
        <span className="un-about-version">v{packageMetadata.version}</span>
      </header>

      {account && props.logoutSelfHostAccount && (
        <PrefSection title="계정">
          <PrefGroup>
            <Pref
              title={account.displayName}
              help={`@${account.username} · 이 기기에서 자동 로그인 중`}
              control={
                <button
                  type="button"
                  className="un-btn is-ghost is-sm"
                  onClick={() => void props.logoutSelfHostAccount?.()}
                >
                  <LogOut size={15} />
                  로그아웃
                </button>
              }
            />
          </PrefGroup>
        </PrefSection>
      )}

      {webAccessUrl && (
        <PrefSection
          title="다른 기기에서 서재 열기"
          hint="같은 서버의 서재가 열려요. 그 주소에 닿는 네트워크가 필요해요."
        >
          {remoteAccessAddress(webAccessUrl).loopback ? (
            <Notice tone="warning">
              지금 주소는 이 기기에서만 열려요. 다른 기기에서는 서버의 내부망 주소나 공개 도메인으로 접속해 주세요.
            </Notice>
          ) : (
            <AccessLinkCard url={webAccessUrl} />
          )}
        </PrefSection>
      )}

      <PrefSection title="이 기기에서">
        <PrefGroup>
          <Pref
            title="실행 환경"
            control={<span className="un-pref-value">{runtimeName(props.platformRuntime, isAndroid)}</span>}
          />
          <Pref
            title="음성"
            help={product ? '이 브라우저의 시스템 음성' : voiceRuntime(props.providerExecutionRuntime)}
          />
          <Pref title="재생" help={playback} />
          <Pref title="오프라인" help={offline} />
          <Pref title="파일" help={files} />
        </PrefGroup>
      </PrefSection>

      <PrefSection title="지원 형식">
        <PrefGroup>
          <Pref title={<FormatTitle icon={<FileText size={16} />} label="TXT · EPUB" />} help="검색, 주석, 듣기" />
          <Pref
            title={<FormatTitle icon={<FileScan size={16} />} label="PDF" />}
            help="글자 추출, OCR, 검색, 주석, 듣기"
          />
          <Pref
            title={<FormatTitle icon={<Images size={16} />} label="ZIP · CBZ · RAR · CBR · 7z · CB7" />}
            help="이어 보기, 두 쪽 보기, 오른쪽에서 왼쪽으로, 자르기·색 보정"
          />
        </PrefGroup>
        <Notice>나눠 압축한 파일은 열 수 없어요. 압축 암호는 열어 둔 동안에만 기억하고 저장하지 않아요.</Notice>
      </PrefSection>

      <PrefSection title="데이터">
        <div className="un-about-privacy">
          <ShieldCheck size={18} aria-hidden="true" />
          <p>
            {product
              ? '책과 독서 기록은 이 브라우저에 저장돼요. 클라우드는 연결했을 때만 써요.'
              : '책과 독서 기록은 기본으로 기기에 저장돼요. AI와 음성 요청은 설정한 서버 작업자나 기기의 보안 연결로만 보내요.'}
          </p>
        </div>
      </PrefSection>

      <PrefSection title="오픈소스">
        <PrefGroup>
          <OutLink href={publicAssetUrl('/LICENSE')} title="BOAA 라이선스" help="Apache License 2.0" />
          <OutLink href={publicAssetUrl('/THIRD_PARTY_NOTICES.md')} title="제3자 고지 전문" />
        </PrefGroup>
        <PrefFold title="압축 파일 구성요소" summary="라이선스 원문은 배포물의 third_party/licenses에 있어요">
          {ARCHIVE_PARTS.map((part) => (
            <OutLink
              key={part.name}
              href={part.source}
              title={part.name}
              help={
                <>
                  {part.purpose} · {part.license}
                </>
              }
            />
          ))}
          <OutLink href={publicAssetUrl(ARCHIVE_PARTS[0].licenseFile)} title="LGPL 2.1 원문" />
        </PrefFold>
      </PrefSection>
    </>
  );
}

function FormatTitle({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <span className="un-about-format">
      {icon}
      {label}
    </span>
  );
}
