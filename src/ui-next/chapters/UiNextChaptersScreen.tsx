import {
  BookOpen,
  Check,
  ChevronLeft,
  Download,
  FileOutput,
  FilePenLine,
  FileUp,
  ListChecks,
  ListTree,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Star,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Chapter, Novel } from '../../domain/types';
import { useNavigationScroll } from '../../features/navigation/navigation-view-state';
import { useReadingChapterPage } from '../../features/chapters/use-reading-chapter-page';
import { paginateChapterRows, type ChapterListRowModel } from '../../features/chapters/chapters-screen-model';
import type { ChaptersScreenProps } from '../../features/chapters/chapters-screen-contract';
import { formatCount, formatDateTime, formatProgress } from '../../utils/format';
import { ActionList, cx, Progress, Segmented, Sheet, type ActionEntry } from '../components/primitives';
import { Pager } from './Pager';
import { Synopsis } from './Synopsis';
import { DetailTags } from './DetailTags';
import { WorkCover } from '../library/WorkTile';
import './chapters.css';
import '../library/library.css';

const PAGE_SIZE = 30;

const SOURCE_FILE_ACCEPT =
  '.txt,.md,.markdown,.epub,.pdf,.zip,.cbz,.rar,.cbr,.7z,.cb7,text/plain,application/epub+zip,application/pdf,application/zip,application/vnd.comicbook+zip,application/vnd.comicbook-rar,application/x-7z-compressed';

const ANALYSIS_LABEL: Partial<Record<NonNullable<Novel['analysisStatus']>, string>> = {
  not_analyzed: '꺼짐',
  mock_ready: 'Mock 준비됨',
  queued: '대기 중',
  analyzing_characters: '인물 분석 중',
  labeling_segments: '라벨링 중',
  building_graph: 'Graph 구축 중',
  validating: '검증 중',
  ready: '라벨 준비됨',
  needs_review: '검토 필요',
  failed: '실패',
  cancelled: '취소됨',
};

function formatLabel(novel: Novel) {
  if (novel.format === 'image_archive') {
    const extension = novel.sourceFileName?.match(/\.([^./\\]+)$/u)?.[1];
    return extension ? extension.toLocaleUpperCase() : '압축 파일';
  }
  return (novel.format ?? 'txt').toLocaleUpperCase();
}

function canAppendChapters(novel: Novel) {
  return novel.format === 'txt' || novel.format === 'markdown' || novel.format === 'epub';
}

function annotationLabel(row: ChapterListRowModel) {
  const counts = row.annotationCounts;
  if (!counts) return '';
  return [
    counts.bookmarks > 0 ? `북마크 ${formatCount(counts.bookmarks)}` : '',
    counts.highlights > 0 ? `하이라이트 ${formatCount(counts.highlights)}` : '',
    counts.notes > 0 ? `메모 ${formatCount(counts.notes)}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

function TitleEditor({ model, actions }: ChaptersScreenProps) {
  return (
    <form
      id="un-title-editor"
      className="un-detail-title-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void actions.titleEditor.save();
      }}
    >
      <input
        value={model.titleEditor.draft}
        onChange={(event) => actions.titleEditor.setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            actions.titleEditor.cancel();
          }
        }}
        autoFocus
        maxLength={120}
        aria-label="책 제목"
      />
      <button type="submit" className="un-icon-btn" aria-label="책 제목 저장">
        <Check size={20} />
      </button>
      <button type="button" className="un-icon-btn" aria-label="책 제목 수정 취소" onClick={actions.titleEditor.cancel}>
        <X size={20} />
      </button>
    </form>
  );
}

function ChapterSheet({
  chapter,
  read,
  actions,
  onClose,
}: {
  chapter: Chapter;
  read: boolean;
  actions: ChaptersScreenProps['actions']['chapterList'];
  onClose(): void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(chapter.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (action: () => Promise<void> | undefined) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await action();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '저장하지 못했어요.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open
      onClose={() => !busy && onClose()}
      title={editing ? '회차 제목 수정' : `${chapter.index}화 · ${chapter.title}`}
    >
      {editing ? (
        <form
          className="un-detail-rename"
          onSubmit={(event) => {
            event.preventDefault();
            void run(() => actions.rename?.(chapter, title));
          }}
        >
          <input
            aria-label="회차 제목"
            value={title}
            maxLength={200}
            autoFocus
            onChange={(event) => setTitle(event.target.value)}
          />
          <div>
            <button type="button" className="un-btn is-text" disabled={busy} onClick={() => setEditing(false)}>
              취소
            </button>
            <button type="submit" className="un-btn is-primary" disabled={busy || !title.trim()}>
              저장
            </button>
          </div>
        </form>
      ) : (
        <div className="un-action-list">
          <button
            type="button"
            className="un-action"
            disabled={busy || read || !actions.markRead}
            onClick={() => void run(() => actions.markRead?.(chapter, false))}
          >
            <Check size={20} />
            <span>{read ? '이미 읽은 회차예요' : '읽음으로 표시'}</span>
          </button>
          <button
            type="button"
            className="un-action"
            disabled={busy || !actions.markRead}
            onClick={() => void run(() => actions.markRead?.(chapter, true))}
          >
            <ListChecks size={20} />
            <span>여기까지 모두 읽음</span>
          </button>
          <button
            type="button"
            className="un-action"
            disabled={busy || !actions.rename}
            onClick={() => setEditing(true)}
          >
            <Pencil size={20} />
            <span>제목 수정</span>
          </button>
        </div>
      )}
      {error && (
        <p className="un-inline-alert" role="alert">
          {error}
        </p>
      )}
    </Sheet>
  );
}

function ChapterRow({
  row,
  progress,
  open,
  openMenu,
}: {
  row: ChapterListRowModel;
  progress: number;
  open(): void;
  openMenu?: () => void;
}) {
  const annotations = annotationLabel(row);
  const state = row.isCurrent ? `읽는 중, ${formatProgress(progress)}` : row.isRead ? '읽음' : '안 읽음';
  return (
    <li className={cx('un-chapter', row.isCurrent && 'is-current', row.isRead && 'is-read')}>
      <button
        type="button"
        className="un-chapter-open"
        aria-current={row.isCurrent ? 'location' : undefined}
        aria-label={`${row.chapter.index}화, ${row.chapter.title}, ${state}`}
        onClick={open}
      >
        <span className="un-chapter-index">{row.chapter.index}</span>
        <span className="un-chapter-text">
          <b>{row.chapter.title}</b>
          <small>
            {row.characterCountLabel} · TTS {row.ttsDuration.label}
            {annotations && ` · ${annotations}`}
          </small>
          {row.isCurrent && <Progress value={progress} className="un-chapter-progress" />}
        </span>
        <span className="un-chapter-state">
          {row.isCurrent ? (
            <>
              <Play size={14} fill="currentColor" />
              이어 읽기
            </>
          ) : row.isRead ? (
            '읽음'
          ) : null}
        </span>
      </button>
      {openMenu && (
        <button type="button" className="un-icon-btn" aria-label={`${row.chapter.title} 작업`} onClick={openMenu}>
          <MoreHorizontal size={18} />
        </button>
      )}
    </li>
  );
}

function ChapterList({ model, actions }: ChaptersScreenProps) {
  const rows = model.chapterList.rows;
  const [menu, setMenu] = useState<ChapterListRowModel | null>(null);
  const [page, setPage] = useReadingChapterPage(
    `ui-next-chapters:${model.book.novel.id}:page`,
    rows.findIndex((row) => row.isCurrent),
    rows.length,
    PAGE_SIZE,
    !model.loading,
  );
  const pageModel = paginateChapterRows(rows, page, PAGE_SIZE);
  const controls = useRef(`${model.book.novel.id}\0${model.query}\0${model.readFilter}\0${model.sort}`);
  useEffect(() => {
    const next = `${model.book.novel.id}\0${model.query}\0${model.readFilter}\0${model.sort}`;
    if (controls.current.split('\0')[0] === model.book.novel.id && controls.current !== next) setPage(1);
    controls.current = next;
  }, [model.book.novel.id, model.query, model.readFilter, model.sort, setPage]);
  const canMenu = Boolean(actions.chapterList.markRead || actions.chapterList.rename);
  const filtered = Boolean(model.query.trim()) || model.readFilter !== 'all';

  return (
    <section className="un-detail-chapters" aria-label="회차">
      <div className="un-detail-toolbar">
        <label className="un-inline-search">
          <Search size={18} />
          <input
            type="search"
            value={model.query}
            onChange={(event) => actions.chapterList.setQuery(event.target.value)}
            placeholder="회차 번호나 제목"
            aria-label="화 검색"
          />
        </label>
        <Segmented
          label="읽은 상태 필터"
          value={model.readFilter}
          onChange={actions.chapterList.setReadFilter}
          options={[
            { value: 'all', label: '전체' },
            { value: 'unread', label: '안 읽음' },
            { value: 'read', label: '읽음' },
          ]}
        />
        <button
          type="button"
          className="un-btn is-text is-sm"
          onClick={() => actions.chapterList.setSort(model.sort === 'asc' ? 'desc' : 'asc')}
          aria-label={`정렬: ${model.sort === 'asc' ? '처음 화부터' : '최신 화부터'}`}
        >
          {model.sort === 'asc' ? '처음 화부터' : '최신 화부터'}
        </button>
      </div>

      {model.loading ? (
        <ul className="un-chapter-list" role="status" aria-label="회차 정보를 불러오는 중">
          {Array.from({ length: 8 }, (_, i) => (
            <li key={i} className="un-chapter is-skeleton" aria-hidden="true">
              <i />
              <span>
                <i />
                <i />
              </span>
            </li>
          ))}
        </ul>
      ) : rows.length === 0 ? (
        <div className="un-empty is-quiet">
          <b>{filtered ? '맞는 회차가 없어요' : '회차가 없어요'}</b>
          {filtered && (
            <button
              type="button"
              className="un-btn is-ghost"
              onClick={() => {
                actions.chapterList.setQuery('');
                actions.chapterList.setReadFilter('all');
              }}
            >
              검색과 필터 지우기
            </button>
          )}
        </div>
      ) : (
        <ul className="un-chapter-list" aria-label={`${model.book.novel.title} 회차 목록`}>
          {pageModel.rows.map((row) => (
            <ChapterRow
              key={row.chapter.id}
              row={row}
              progress={model.summary.readChapterProgress}
              open={() => void actions.chapterList.openChapter(row.chapter, row.isCurrent)}
              openMenu={canMenu ? () => setMenu(row) : undefined}
            />
          ))}
        </ul>
      )}

      {!model.loading && rows.length > 0 && (
        <footer className="un-detail-pager">
          <small>
            {pageModel.rangeStart}–{pageModel.rangeEnd} / {formatCount(pageModel.resultCount)}화
          </small>
          <Pager page={pageModel.page} count={pageModel.pageCount} onPage={setPage} />
        </footer>
      )}

      {menu && (
        <ChapterSheet
          key={menu.chapter.id}
          chapter={menu.chapter}
          read={menu.isRead}
          actions={actions.chapterList}
          onClose={() => setMenu(null)}
        />
      )}
    </section>
  );
}

function InfoPanel({ model }: ChaptersScreenProps) {
  const { novel } = model.book;
  const { summary } = model;
  const facts: [string, string][] = [
    ['형식', formatLabel(novel)],
    ['총 회차', `${formatCount(novel.totalChapters)}화`],
    ['분량', `${formatCount(novel.totalCharacters)}자 · ${formatCount(novel.totalParagraphs)}문단`],
    ['진행률', formatProgress(model.book.bookProgress)],
    ['현재 위치', summary.readLocationLabel],
    ['최근 읽음', model.book.lastReadLabel],
    ['누적 독서 시간', model.book.readingTimeLabel],
    ['북마크', `${formatCount(summary.bookmarkCount)}개`],
    ['하이라이트', `${formatCount(summary.highlightCount)}개`],
    ['메모', `${formatCount(summary.noteCount)}개`],
    ['동기화', summary.syncLabel],
    ['AI 애드온', ANALYSIS_LABEL[novel.analysisStatus] ?? novel.analysisStatus],
    ['원본 파일', novel.sourceFileName],
    [
      '원본 보관',
      novel.sourceAssetId
        ? `${novel.sourceProvenance === 'original' ? '원본' : '재구성'} · ${formatCount(novel.sourceByteLength ?? 0)}B`
        : '보관된 원본 없음',
    ],
    ['인코딩', novel.sourceEncoding?.toLocaleUpperCase() ?? '-'],
    ['수정일', formatDateTime(novel.updatedAt)],
  ];
  return (
    <dl className="un-detail-facts">
      {facts.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd title={value}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function UiNextChaptersScreen({ model, actions }: ChaptersScreenProps) {
  const scrollRef = useRef<HTMLElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<'chapters' | 'info'>('chapters');
  const [moreOpen, setMoreOpen] = useState(false);
  useNavigationScroll(scrollRef, `ui-next-chapters:${model.book.novel.id}`);

  const { book, summary } = model;
  const { novel } = book;
  const current = summary.currentReadTargetChapter;
  const resumeLabel = book.isUnread ? '첫 화 보기' : current ? `${current.index}화 이어 읽기` : '이어 읽기';
  const byline = [novel.author, novel.seriesTitle].filter(Boolean).join(' · ');

  const more: ActionEntry[] = [
    {
      id: 'title',
      label: model.titleEditor.editing ? '제목 수정 취소' : '제목 빠르게 고치기',
      icon: <Pencil size={20} />,
      run: model.titleEditor.editing ? actions.titleEditor.cancel : actions.titleEditor.start,
    },
    ...(novel.format !== 'epub'
      ? [
          {
            id: 'structure',
            label: '회차 나누기 편집',
            icon: <ListTree size={20} />,
            run: actions.navigation.openStructureEditor,
          },
        ]
      : []),
    ...(canAppendChapters(novel)
      ? [{ id: 'append', label: '회차 추가', icon: <Plus size={20} />, run: actions.navigation.openChapterAppend }]
      : []),
    'divider',
    {
      id: 'first-unread',
      label: '첫 안 읽은 화 열기',
      icon: <BookOpen size={20} />,
      disabled: !summary.firstUnreadChapter,
      run: actions.book.openFirstUnreadChapter,
    },
    {
      id: 'mark-current',
      label: '지금 회차 읽음으로',
      icon: <Check size={20} />,
      disabled: !summary.canMarkCurrentChapterRead,
      run: actions.book.markCurrentChapterRead,
    },
    {
      id: 'finish',
      label: '완독으로 표시',
      icon: <ListChecks size={20} />,
      disabled: !summary.canMarkBookFinished,
      run: actions.book.markFinished,
    },
    'divider',
    {
      id: 'export',
      label: '원본 내려받기',
      icon: <Download size={20} />,
      disabled: !novel.sourceAssetId,
      run: () => actions.book.exportSource(novel),
    },
    { id: 'reselect', label: '원본 다시 고르기', icon: <FileUp size={20} />, run: () => fileInput.current?.click() },
    ...(!novel.sourceAssetId
      ? [
          {
            id: 'reconstruct',
            label: '재구성본 만들기',
            icon: <FileOutput size={20} />,
            run: () => actions.book.reconstructSource(novel),
          },
        ]
      : []),
    { id: 'settings', label: '읽기 설정', icon: <SlidersHorizontal size={20} />, run: actions.navigation.openSettings },
    { id: 'sync', label: '동기화 상세', icon: <RefreshCw size={20} />, run: actions.navigation.openSync },
    'divider',
    {
      id: 'reset',
      label: '읽은 기록 지우기',
      icon: <RotateCcw size={20} />,
      danger: true,
      disabled: !summary.canResetBookProgress,
      run: actions.book.resetProgress,
    },
  ];

  return (
    <main ref={scrollRef} className="un-detail">
      <section className="un-detail-hero" aria-labelledby="un-detail-title">
        <div className="un-detail-backdrop" aria-hidden="true">
          <WorkCover item={{ kind: 'book', key: novel.id, book }} />
        </div>
        <button type="button" className="un-detail-back" onClick={actions.navigation.backToLibrary}>
          <ChevronLeft size={22} />
          <span>뒤로</span>
        </button>
        <div className="un-detail-body">
          <div className="un-detail-cover">
            <WorkCover item={{ kind: 'book', key: novel.id, book }} />
          </div>
          <div className="un-detail-copy">
            <div className="un-detail-info">
              {model.titleEditor.editing ? (
                <TitleEditor model={model} actions={actions} />
              ) : (
                <h1 id="un-detail-title">{novel.title}</h1>
              )}
              {byline && <p className="un-detail-byline">{byline}</p>}
              <p className="un-detail-kicker">
                <span className={cx('un-tag', book.isFinished ? '' : !book.isUnread && 'is-accent')}>
                  {book.readingStatusLabel === '미독' ? '안 읽음' : book.readingStatusLabel}
                </span>
                <span>{formatLabel(novel)}</span>
                <span>{formatCount(novel.totalChapters)}화</span>
                <span>{formatCount(novel.totalCharacters)}자</span>
              </p>
              {novel.tags && novel.tags.length > 0 && <DetailTags tags={novel.tags} />}
            </div>
            {!book.isUnread && (
              <div className="un-detail-progress">
                <span>{book.readingPositionLabel}</span>
                <Progress value={book.bookProgress} label="전체 진행률" />
                <small>{formatProgress(book.bookProgress)}</small>
              </div>
            )}
            <div className="un-detail-actions">
              <div className="un-detail-main-actions">
                <button
                  type="button"
                  className="un-btn is-primary is-lg"
                  onClick={() => void actions.navigation.continueReading()}
                >
                  <Play size={18} fill="currentColor" />
                  {resumeLabel}
                </button>
              </div>
              <button
                type="button"
                className={cx('un-detail-icon-action', novel.favorite && 'is-on')}
                aria-pressed={novel.favorite}
                onClick={() => void actions.book.toggleFavorite(novel)}
              >
                <Star size={22} fill={novel.favorite ? 'currentColor' : 'none'} />
                <span>즐겨찾기</span>
              </button>
              <button
                type="button"
                className="un-detail-icon-action"
                aria-label="작품 정보 편집"
                onClick={actions.navigation.openMetadata}
              >
                <FilePenLine size={22} />
                <span>편집</span>
              </button>
              <button
                type="button"
                className="un-detail-icon-action"
                aria-label="더보기"
                onClick={() => setMoreOpen(true)}
              >
                <MoreHorizontal size={22} />
                <span>더보기</span>
              </button>
            </div>
            {novel.description && <Synopsis text={novel.description} />}
          </div>
        </div>
      </section>

      <div className="un-detail-tabs">
        <div className="un-underline-tabs" role="tablist" aria-label="작품 상세">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'chapters'}
            className={cx(tab === 'chapters' && 'is-active')}
            onClick={() => setTab('chapters')}
          >
            회차<small>{formatCount(model.chapterList.totalCount)}</small>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'info'}
            className={cx(tab === 'info' && 'is-active')}
            onClick={() => setTab('info')}
          >
            정보
          </button>
        </div>
      </div>

      {tab === 'chapters' ? (
        <ChapterList model={model} actions={actions} />
      ) : (
        <InfoPanel model={model} actions={actions} />
      )}

      <input
        ref={fileInput}
        type="file"
        hidden
        accept={SOURCE_FILE_ACCEPT}
        aria-label="원본 파일 선택"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void actions.book.reselectSource(novel, file);
        }}
      />
      <Sheet open={moreOpen} onClose={() => setMoreOpen(false)} title={novel.title}>
        <ActionList actions={more} onDone={() => setMoreOpen(false)} />
      </Sheet>
    </main>
  );
}
