import { ChevronLeft, ChevronRight, RefreshCw, X } from 'lucide-react';
import { useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useOptionalAppRuntime } from '../../app/runtime/RuntimeProvider';
import { serverManagementApi } from '../../features/server-management/use-server-management-client';
import { useOptionalSelfHostAuth } from '../../features/auth/SelfHostAccountGate';
import { useSelfHostCapability } from '../../features/auth/self-host-account-api';
import { EmbeddedAccessContext } from '../../platform/embedded-access-context';
import {
  SETTINGS_SECTIONS,
  saveStatusLabel,
  type ReaderSettingsPanelProps,
  type SettingsTab,
} from '../../features/reader-settings/settings-panel-contract';
import { UiNextSettingsTabContent } from './UiNextSettingsTabContent';
import { cx, Switch } from '../components/primitives';
import { UiNextSourceReadingSettings } from './UiNextSourceReadingSettings';
import '../styles/tokens.css';
import '../styles/kit.css';
import './settings.css';

/** Category groups shown as an inset list, like a native settings app. */
const GROUPS: readonly { title: string; ids: readonly SettingsTab[] }[] = [
  { title: '계정', ids: ['account'] },
  { title: '일반', ids: ['appearance'] },
  { title: '읽기', ids: ['layout', 'gesture'] },
  { title: '콘텐츠', ids: ['sources', 'extensions'] },
  { title: '데이터', ids: ['storage', 'sync', 'remote-access'] },
  { title: '관리', ids: ['server'] },
  { title: '정보', ids: ['application'] },
];

const PHONE = '(max-width: 899px)';

/** Full-page settings for ui-next. Reuses every classic settings section; only the frame and navigation change. */
export default function UiNextSettingsPanel(props: ReaderSettingsPanelProps) {
  const { controller } = props;
  const [tab, setTab] = useState<SettingsTab>(
    props.initialTab === 'downloads' ? 'sources' : (props.initialTab ?? 'appearance'),
  );
  /** Phones show the category list first and push a page; wide screens show both. */
  const [detail, setDetail] = useState(Boolean(props.initialTab));
  const [storageBusy, setStorageBusy] = useState(false);
  const [focusDownloads, setFocusDownloads] = useState(props.initialTab === 'downloads');
  const titleRef = useRef<HTMLHeadingElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const embedded = useContext(EmbeddedAccessContext);
  const handledUpdates = useRef(0);
  const serverManaged = Boolean(serverManagementApi(useOptionalAppRuntime()));
  const selfHostAuth = useOptionalSelfHostAuth();
  const canManageServer = useSelfHostCapability('manageServer');
  const accountManager = selfHostAuth?.session?.context.capabilities.manageAccounts === true;

  const sections = SETTINGS_SECTIONS.filter((section) => {
    if (section.id === 'remote-access') return Boolean(embedded) || Boolean(props.serverApiBaseUrl);
    if (section.id === 'server') return serverManaged && canManageServer;
    if (section.id === 'account') return Boolean(selfHostAuth?.session);
    return true;
  });
  const current = sections.find((section) => section.id === tab) ?? sections[0];
  const status = saveStatusLabel(controller);

  const focusTitle = () =>
    requestAnimationFrame(() => {
      titleRef.current?.focus({ preventScroll: true });
      if (contentRef.current) contentRef.current.scrollTop = 0;
    });

  const selectTab = (next: SettingsTab) => {
    if (storageBusy) return;
    setFocusDownloads(next === 'downloads');
    // Source reading and downloads live under 콘텐츠 소스 in ui-next.
    setTab(next === 'downloads' ? 'sources' : next);
    setDetail(true);
    focusTitle();
  };
  const back = () => {
    setDetail(false);
    requestAnimationFrame(() => document.getElementById(`un-settings-tab-${tab}`)?.focus());
  };
  const close = () => {
    if (!storageBusy) controller.closePanel();
  };
  const openDestination = (destination: () => void) => {
    controller.closePanel();
    destination();
  };

  useEffect(() => {
    if (
      !props.updatesRequest ||
      props.initialTab !== 'sources' ||
      storageBusy ||
      handledUpdates.current === props.updatesRequest
    )
      return;
    handledUpdates.current = props.updatesRequest;
    setTab('sources');
    setDetail(true);
    focusTitle();
  }, [props.updatesRequest, props.initialTab, storageBusy]);

  useEffect(() => {
    if (!controller.open) return;
    const previous = document.activeElement as HTMLElement | null;
    document.documentElement.style.overflow = 'hidden';
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      // Nested classic dialogs handle their own Escape first.
      if (document.querySelector('.modal-backdrop, .un-layer')) return;
      event.preventDefault();
      if (detail && window.matchMedia(PHONE).matches) back();
      else close();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.documentElement.style.overflow = '';
      previous?.focus?.({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller.open, detail, storageBusy]);

  if (!controller.open) return null;
  const readingTab = tab === 'appearance' || tab === 'layout' || tab === 'gesture';
  const showReadingFooter = tab === 'layout';

  return createPortal(
    <div
      className={cx('ui-next un-settings reader-settings-dialog', detail && 'is-detail')}
      role="dialog"
      aria-modal="true"
      aria-label="설정"
    >
      <header className="un-settings-bar">
        <button
          type="button"
          className="un-icon-btn un-settings-back"
          aria-label="설정 목록"
          disabled={storageBusy}
          onClick={back}
        >
          <ChevronLeft size={24} />
        </button>
        <h1 className="un-settings-heading">설정</h1>
        <span className="un-settings-status" role="status" aria-live="polite">
          {status}
        </span>
        <button type="button" className="un-icon-btn" aria-label="설정 닫기" disabled={storageBusy} onClick={close}>
          <X size={22} />
        </button>
      </header>

      <div className="un-settings-body">
        <nav className="un-settings-nav" aria-label="설정 분류">
          {GROUPS.map((group) => {
            const items = sections.filter((section) => group.ids.includes(section.id));
            if (!items.length) return null;
            return (
              <section key={group.title} className="un-settings-group">
                <h2>{group.title}</h2>
                <div className="un-settings-list" role="tablist" aria-orientation="vertical" aria-label={group.title}>
                  {items.map((section) => {
                    const Icon = section.icon;
                    const selected = section.id === tab;
                    return (
                      <button
                        key={section.id}
                        id={`un-settings-tab-${section.id}`}
                        type="button"
                        role="tab"
                        aria-selected={selected}
                        aria-controls="un-settings-panel"
                        disabled={storageBusy}
                        className={cx('un-settings-item', selected && 'is-active')}
                        onClick={() => selectTab(section.id)}
                      >
                        <span className={cx('un-settings-icon', `is-${section.id}`)} aria-hidden="true">
                          <Icon size={18} />
                        </span>
                        <span className="un-settings-item-text">
                          <b>{section.label}</b>
                          <small>
                            {section.id === 'appearance'
                              ? '시작 화면'
                              : section.id === 'account' && selfHostAuth
                                ? `${selfHostAuth.account.displayName}${accountManager ? ' · 회원 관리' : ''}`
                                : section.detail}
                          </small>
                        </span>
                        <ChevronRight size={18} className="un-settings-chevron" aria-hidden="true" />
                      </button>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </nav>

        <main className="un-settings-main">
          <div ref={contentRef} className="un-settings-content reader-settings-content">
            <h2 ref={titleRef} tabIndex={-1} className="un-settings-title">
              {current.label}
            </h2>
            <div
              id="un-settings-panel"
              role="tabpanel"
              aria-labelledby={`un-settings-tab-${tab}`}
              className="reader-settings-panel un-settings-panel"
            >
              <UiNextSettingsTabContent
                {...props}
                tab={tab}
                onStorageBusyChange={setStorageBusy}
                openDestination={openDestination}
                sourceReadingSettings={
                  <UiNextSourceReadingSettings controller={props.externalSources} focus={focusDownloads} />
                }
              />
            </div>
            {showReadingFooter && props.contrastWarning && (
              <div className="un-inline-alert" role="alert">
                <span>글자와 배경의 대비가 낮아 읽기 어려울 수 있어요.</span>
                <button
                  type="button"
                  className="un-btn is-text is-sm"
                  onClick={() => props.updateProfile({ foreground: '#eeeeea', background: '#181817' })}
                >
                  기본 대비
                </button>
              </div>
            )}
            {readingTab && controller.saveError && (
              <div className="un-inline-alert" role="alert">
                <span>읽기 설정을 저장하지 못했어요.</span>
                <button type="button" className="un-btn is-text is-sm" onClick={controller.retrySave}>
                  다시 저장
                </button>
              </div>
            )}
          </div>
          {showReadingFooter && (
            <footer className="un-settings-foot">
              <label className="un-settings-override">
                <Switch
                  label="이 책에만 적용"
                  checked={props.bookOverrideEnabled}
                  onChange={props.setBookOverrideEnabled}
                />
                <span>이 책에만 적용</span>
              </label>
              <button type="button" className="un-btn is-text is-sm" onClick={props.resetProfile}>
                <RefreshCw size={15} aria-hidden="true" />
                {props.bookOverrideEnabled ? '책 설정 초기화' : '기본값으로'}
              </button>
            </footer>
          )}
        </main>
      </div>
    </div>,
    document.body,
  );
}
