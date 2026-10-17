import { ArrowRight, Pin, Search } from 'lucide-react';
import { useEffect } from 'react';
import type { ExternalSourceListInput } from '../../external-sources/contracts';
import type { ExternalSourceView } from '../../features/external-sources/useExternalSourceController';
import { useSourceQuickJumpModel } from '../../features/discovery/use-source-quick-jump-model';
import { cx, Sheet } from '../components/primitives';
import { EmptyState, Notice } from '../components/prefs';
import './discovery-tools.css';

/** 소스로 바로 가기: find a source by name and open it; catalog sources can be pinned as tabs. */
export function SourceJumpSheet({
  sources,
  close,
  open,
  error,
  pinned,
  togglePin,
  saving,
}: {
  sources: readonly ExternalSourceView[];
  error?: string;
  saving?: boolean;
  pinned: readonly string[];
  togglePin(source: ExternalSourceView): void;
  close(): void;
  open(source: string, input: ExternalSourceListInput): void | boolean | Promise<void | boolean>;
}) {
  const model = useSourceQuickJumpModel({ sources, close, open });
  useEffect(() => {
    const frame = requestAnimationFrame(() => model.search.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [model.search]);
  return (
    <Sheet open onClose={close} title="소스로 바로 가기">
      <div className="un-dtools">
        <label className="un-dtools-search">
          <Search size={16} aria-hidden="true" />
          <input
            ref={model.search}
            type="search"
            className="un-input"
            aria-label="이동할 소스 검색"
            placeholder="소스 이름으로 찾기"
            value={model.query}
            onChange={(event) => model.setQuery(event.target.value)}
          />
        </label>
        {error && <Notice tone="warning">{error}</Notice>}
        {model.matches.length ? (
          <ul className="un-dtools-list">
            {model.matches.map((source) => {
              const connected = source.connection.state === 'connected';
              const isPinned = pinned.includes(source.id);
              return (
                <li key={source.id}>
                  <button
                    type="button"
                    className="un-dtools-go"
                    disabled={saving || !connected}
                    onClick={() => void model.jump(source)}
                  >
                    <span>
                      <b>{source.title}</b>
                      {!connected && <small>소스 설정에서 먼저 연결해 주세요</small>}
                    </span>
                    <ArrowRight size={17} aria-hidden="true" />
                  </button>
                  {source.kind === 'catalog' && (
                    <button
                      type="button"
                      className={cx('un-icon-btn is-sm un-dtools-pin', isPinned && 'is-on')}
                      disabled={saving}
                      aria-pressed={isPinned}
                      aria-label={`${source.title} ${isPinned ? '탭에서 빼기' : '탭으로 고정'}`}
                      onClick={() => togglePin(source)}
                    >
                      <Pin size={16} fill={isPinned ? 'currentColor' : 'none'} />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState
            icon={<Search size={22} />}
            title={sources.length ? '맞는 소스가 없어요' : '아직 소스가 없어요'}
            body={sources.length ? undefined : '설정 › 콘텐츠 소스에서 추가해 주세요.'}
          />
        )}
      </div>
    </Sheet>
  );
}
