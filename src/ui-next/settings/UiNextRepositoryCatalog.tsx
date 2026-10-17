import { Copy, Link2, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type {
  InstalledExtensionManager,
  InstalledExtensionsSnapshot,
  PackageReview,
} from '../../extensions/packages/installed-extension-manager';
import { comparePackageVersions } from '../../extensions/packages/package-installer';
import { packageOperationMessage } from '../../extensions/packages/package-operation-error';
import type { RepositoryRecord } from '../../extensions/packages/repository-contract';
import { cx } from '../components/primitives';
import { ExtensionAvatar } from './ExtensionAvatar';

const PAGE = 30;

function repositoryKind(error: unknown): 'mangayomi' | 'apk' | undefined {
  if (!(error instanceof Error)) return undefined;
  const matches = (code: string) =>
    error.message === code || error.message === packageOperationMessage(new Error(code));
  if (matches('package_repository_mangayomi')) return 'mangayomi';
  if (matches('package_repository_suwayomi')) return 'apk';
  return undefined;
}

function hostLabel(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** ui-next BOAA catalogue: paste an address once, then browse every package as a plain list. */
export function UiNextRepositoryCatalog({
  manager,
  snapshot,
  disabled,
  renderReview,
  onReview,
  onMangayomiRepository,
  onApkRepository,
}: {
  manager: InstalledExtensionManager;
  snapshot: InstalledExtensionsSnapshot;
  disabled: boolean;
  renderReview(id: string): ReactNode;
  onReview(value: { file: File; plan: PackageReview }): void;
  onMangayomiRepository?(url: string): void;
  onApkRepository?(url: string): void;
}) {
  const [repositories, setRepositories] = useState<readonly RepositoryRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [url, setUrl] = useState('');
  const [selected, setSelected] = useState('');
  const [query, setQuery] = useState('');
  const [updatesOnly, setUpdatesOnly] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => {
    let active = true;
    void manager.listRepositories!()
      .then((items) => {
        if (!active) return;
        setRepositories(items);
        setSelected(items[0]?.url ?? '');
      })
      .catch(() => active && setError('저장소를 읽지 못했어요. 서버 또는 앱 버전을 확인해 주세요.'))
      .finally(() => active && setLoaded(true));
    return () => {
      active = false;
    };
  }, [manager]);

  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await task();
    } catch (cause) {
      setError(
        packageOperationMessage(cause) ??
          '저장소를 불러오지 못했어요. 주소와 연결을 확인해 주세요. 저장된 목록은 그대로예요.',
      );
    } finally {
      setBusy(false);
    }
  };

  const add = () =>
    void run(async () => {
      const address = url.trim();
      let saved: RepositoryRecord;
      try {
        saved = await manager.refreshRepository!(address);
      } catch (cause) {
        const kind = repositoryKind(cause);
        if (kind === 'mangayomi' && onMangayomiRepository) {
          setUrl('');
          onMangayomiRepository(address);
          return;
        }
        if (kind === 'apk' && onApkRepository) {
          setUrl('');
          onApkRepository(address);
          return;
        }
        throw cause;
      }
      setRepositories(await manager.listRepositories!());
      setSelected(saved.url);
      setUrl('');
      setLimit(PAGE);
    });

  const record = repositories.find((item) => item.url === selected);
  const locked = busy || disabled;
  const needle = query.trim().toLocaleLowerCase();
  const entries = (record?.index?.packages ?? [])
    .map((entry) => {
      const installed = snapshot.packages.find((pkg) => pkg.id === entry.id)?.active;
      return {
        entry,
        installed,
        newer: !!installed && comparePackageVersions(entry.version, installed.manifest.extension.version) > 0,
      };
    })
    .filter(
      ({ entry, newer }) =>
        (!updatesOnly || newer) &&
        `${entry.name ?? ''} ${entry.id} ${entry.description ?? ''}`.toLocaleLowerCase().includes(needle),
    );
  const updateCount = (record?.index?.packages ?? []).filter((entry) => {
    const installed = snapshot.packages.find((pkg) => pkg.id === entry.id)?.active;
    return installed && comparePackageVersions(entry.version, installed.manifest.extension.version) > 0;
  }).length;

  return (
    <section className="un-ext-catalog" aria-label="확장 저장소">
      <form
        className="un-ext-address"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <Link2 size={17} aria-hidden="true" />
        <input
          type="url"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          aria-label="저장소 주소"
          placeholder="저장소 주소 붙여넣기 (https://…)"
          value={url}
          maxLength={2048}
          required
          disabled={locked}
          onChange={(event) => setUrl(event.target.value)}
        />
        <button type="submit" className="un-btn is-primary is-sm" disabled={locked || !url.trim()}>
          {busy ? (
            <RefreshCw size={15} className="un-ext-spin" aria-hidden="true" />
          ) : (
            <Plus size={16} aria-hidden="true" />
          )}
          추가
        </button>
      </form>

      {error && (
        <p role="alert" className="un-ext-note is-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="un-ext-note">
          {notice}
        </p>
      )}

      {repositories.length > 0 && (
        <>
          <div className="un-ext-repos" role="tablist" aria-label="확장 저장소 선택">
            {repositories.map((item) => (
              <button
                key={item.url}
                type="button"
                role="tab"
                aria-selected={item.url === selected}
                className={cx('un-chip', item.url === selected && 'is-active')}
                disabled={locked}
                onClick={() => {
                  setSelected(item.url);
                  setLimit(PAGE);
                  setConfirmRemove(false);
                }}
              >
                {item.index?.name || hostLabel(item.url)}
                <small>{item.index?.packages.length ?? 0}</small>
              </button>
            ))}
          </div>

          {record && (
            <div className="un-ext-repo">
              <div className="un-ext-repo-info">
                <code title={record.url}>{record.url}</code>
                {record.checkedAt && (
                  <small>
                    {new Date(record.checkedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}{' '}
                    확인
                  </small>
                )}
              </div>
              {confirmRemove ? (
                <span className="un-ext-confirm">
                  <small>설치한 확장은 남아요.</small>
                  <button type="button" className="un-btn is-text is-sm" onClick={() => setConfirmRemove(false)}>
                    취소
                  </button>
                  <button
                    type="button"
                    className="un-btn is-sm un-ext-danger"
                    disabled={locked}
                    onClick={() =>
                      void run(async () => {
                        await manager.removeRepository!(record.url, record.revision);
                        const items = await manager.listRepositories!();
                        setRepositories(items);
                        setSelected(items[0]?.url ?? '');
                        setConfirmRemove(false);
                      })
                    }
                  >
                    삭제
                  </button>
                </span>
              ) : (
                <span className="un-ext-repo-actions">
                  <button
                    type="button"
                    className="un-icon-btn is-sm"
                    aria-label="목록·업데이트 확인"
                    title="목록·업데이트 확인"
                    disabled={locked}
                    onClick={() =>
                      void run(async () => {
                        await manager.refreshRepository!(record.url);
                        setRepositories(await manager.listRepositories!());
                        setNotice('저장소 목록을 새로 받았어요.');
                      })
                    }
                  >
                    <RefreshCw size={16} className={cx(busy && 'un-ext-spin')} />
                  </button>
                  <button
                    type="button"
                    className="un-icon-btn is-sm"
                    aria-label="URL 복사"
                    title="URL 복사"
                    onClick={() =>
                      void navigator.clipboard
                        .writeText(record.url)
                        .then(() => setNotice('주소를 복사했어요.'))
                        .catch(() => setNotice('복사하지 못했어요. 주소를 직접 복사해 주세요.'))
                    }
                  >
                    <Copy size={16} />
                  </button>
                  <button
                    type="button"
                    className="un-icon-btn is-sm un-ext-remove"
                    aria-label="저장소 삭제"
                    title="저장소 삭제"
                    disabled={locked}
                    onClick={() => setConfirmRemove(true)}
                  >
                    <Trash2 size={16} />
                  </button>
                </span>
              )}
            </div>
          )}

          <div className="un-ext-filter">
            <label className="un-ext-search">
              <Search size={16} aria-hidden="true" />
              <input
                type="search"
                aria-label="확장 검색"
                placeholder="이름·설명 검색"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setLimit(PAGE);
                }}
              />
            </label>
            <button
              type="button"
              aria-pressed={updatesOnly}
              className={cx('un-chip', updatesOnly && 'is-active')}
              onClick={() => {
                setUpdatesOnly(!updatesOnly);
                setLimit(PAGE);
              }}
            >
              업데이트만{updateCount > 0 && <small>{updateCount}</small>}
            </button>
          </div>

          {entries.length > 0 ? (
            <div className="un-ext-list" aria-label="저장소 확장 목록">
              {entries.slice(0, limit).map(({ entry, installed, newer }) => {
                const review = renderReview(entry.id);
                const name = entry.name || entry.id;
                return (
                  <article key={entry.id} className="un-ext-item">
                    <div className="un-ext-item-row is-static">
                      <span className="un-ext-item-main">
                        <ExtensionAvatar name={name} />
                        <span>
                          <strong>{name}</strong>
                          {entry.description && <span className="un-ext-desc">{entry.description}</span>}
                          <small>
                            v{entry.version}
                            {installed &&
                              (newer ? ` · 설치된 v${installed.manifest.extension.version}에서 업데이트` : ' · 설치됨')}
                          </small>
                        </span>
                      </span>
                      {!review && (
                        <button
                          type="button"
                          className={cx('un-btn is-sm un-ext-get', installed && !newer ? 'is-done' : 'is-primary')}
                          disabled={locked || (!!installed && !newer)}
                          onClick={() =>
                            void run(async () => {
                              onReview(await manager.selectRepositoryPackage!(record!.url, entry.id, entry.sha256));
                            })
                          }
                        >
                          {newer ? '업데이트' : installed ? '설치됨' : '받기'}
                        </button>
                      )}
                    </div>
                    {review && <div className="un-ext-item-body is-review">{review}</div>}
                  </article>
                );
              })}
            </div>
          ) : (
            <p className="un-ext-note">
              {needle || updatesOnly ? '조건에 맞는 확장이 없어요.' : '이 저장소에 확장이 없어요.'}
            </p>
          )}
          {entries.length > limit && (
            <button type="button" className="un-btn is-ghost un-ext-more" onClick={() => setLimit(limit + PAGE)}>
              {entries.length - limit}개 더 보기
            </button>
          )}
        </>
      )}

      {loaded && !repositories.length && !error && (
        <p className="un-ext-note">
          배포처에서 받은 저장소 주소를 붙여넣으세요. BOAA·Mangayomi·APK 저장소는 형식을 알아서 찾아 해당 목록으로
          옮겨요.
        </p>
      )}
    </section>
  );
}
