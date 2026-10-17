import { memo, useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { Character, LabeledSegment, Paragraph } from '../../domain/types';
import type { BookAssetRepository } from '../../repositories/book-asset-repository';
import { composePluginText, type ComposedReaderSegment } from '../../reader/plugin-text-composition';
import { decorateReaderText } from '../../reader/text-decorations';
import type { ReaderDecorationStore } from './reader-decoration-store';
import type { ReaderMode } from './reader-screen-contract';

function classNames(...values: Array<string | false | undefined>): string {
  return values.filter(Boolean).join(' ');
}

export function segmentTypeLabel(segment: Pick<LabeledSegment, 'type'>): string {
  if (segment.type === 'narration') return '서술';
  if (segment.type === 'quoted_dialogue' || segment.type === 'plain_dialogue') return '대사';
  if (segment.type === 'inner_monologue') return '독백';
  if (segment.type === 'sfx') return '효과음';
  return '기타';
}

function speakerLabel(segment: LabeledSegment, characters: readonly Character[]): string {
  if (segment.speakerId === 'narrator') return '내레이터';
  if (segment.speakerId === 'system') return '시스템';
  if (segment.speakerId === 'unknown') return '화자 미확정';
  return characters.find((character) => character.id === segment.speakerId)?.canonicalName ?? segment.speakerId;
}

export interface ReaderParagraphRowProps {
  readonly paragraph: Paragraph;
  readonly virtualIndex: number;
  readonly start: number;
  readonly estimatedSize?: number;
  readonly isSpeaking: boolean;
  readonly mode: ReaderMode;
  readonly searchQuery: string;
  readonly decorationStore: ReaderDecorationStore;
  readonly measureElement: (element: Element | null) => void;
  readonly onSelectCorrectionSegment: (segmentId: string) => void;
  readonly assetRepository?: BookAssetRepository;
  readonly onDocumentLink?: (href: string, footnote: boolean) => void;
  readonly staticLayout?: boolean;
  readonly sourceOffset?: number;
  readonly sourceText?: string;
}

function EpubImage({
  repository,
  bookId,
  assetId,
  alt,
  onReady,
}: {
  repository?: BookAssetRepository;
  bookId: string;
  assetId?: string;
  alt: string;
  onReady: () => void;
}) {
  const [source, setSource] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    let objectUrl: string | undefined;
    setSource(undefined);
    setFailed(false);
    if (!repository || !assetId) {
      setFailed(true);
      return;
    }
    void repository
      .getEmbeddedResource(bookId, assetId)
      .then((resource) => {
        if (!active || !resource) {
          if (active) setFailed(true);
          return;
        }
        objectUrl = URL.createObjectURL(resource.blob);
        setSource(objectUrl);
      })
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [assetId, bookId, repository]);
  if (failed) return <div className="reader-image-placeholder">{alt || '이미지를 표시할 수 없습니다.'}</div>;
  if (!source) return <div className="reader-image-placeholder is-loading" aria-label="이미지 불러오는 중" />;
  return (
    <img
      className="reader-epub-image"
      src={source}
      alt={alt}
      onLoad={onReady}
      onError={() => {
        setFailed(true);
        onReady();
      }}
    />
  );
}

function sliceSegments(
  segments: readonly ComposedReaderSegment[],
  start: number,
  end: number,
): ComposedReaderSegment[] {
  let offset = 0;
  return segments.flatMap((segment) => {
    const begin = offset,
      stop = offset + segment.text.length;
    offset = stop;
    return begin < end && stop > start
      ? [
          {
            ...segment,
            text: segment.text.slice(Math.max(0, start - begin), Math.min(segment.text.length, end - begin)),
          },
        ]
      : [];
  });
}
function renderSegments(segments: readonly ComposedReaderSegment[]): ReactNode {
  return segments.map((part, index) => {
    const className =
      classNames(
        part.highlightColor && 'reader-inline-highlight',
        part.highlightColor && `inline-highlight-${part.highlightColor}`,
        part.ttsActive && 'reader-tts-active',
      ) || undefined;
    const style = part.pluginStyle
      ? {
          color: part.pluginStyle.color,
          backgroundColor: part.pluginStyle.backgroundColor,
          textDecorationLine:
            [part.pluginStyle.underline && 'underline', part.pluginStyle.strikethrough && 'line-through']
              .filter(Boolean)
              .join(' ') || undefined,
          fontWeight: part.pluginStyle.fontWeight,
          fontStyle: part.pluginStyle.fontStyle,
        }
      : undefined;
    return part.searchHit ? (
      <mark key={index} className={className} style={style}>
        {part.text}
      </mark>
    ) : (
      <span key={index} className={className} style={style}>
        {part.text}
      </span>
    );
  });
}

function InlineEpubText({
  paragraph,
  onLink,
  segments,
}: {
  paragraph: Paragraph;
  segments: readonly ComposedReaderSegment[];
  onLink: (href: string, footnote: boolean) => void;
}): ReactNode {
  const marks = paragraph.inlineMarks ?? [];
  const semantics = paragraph.inlineSemantics ?? [];
  if (marks.length === 0 && semantics.length === 0) return renderSegments(segments);
  const boundaries = new Set([0, paragraph.text.length]);
  marks.forEach((mark) => {
    boundaries.add(Math.max(0, Math.min(paragraph.text.length, mark.start)));
    boundaries.add(Math.max(0, Math.min(paragraph.text.length, mark.end)));
  });
  semantics.forEach((semantic) => {
    boundaries.add(Math.max(0, Math.min(paragraph.text.length, semantic.start)));
    boundaries.add(Math.max(0, Math.min(paragraph.text.length, semantic.end)));
  });
  const points = [...boundaries].sort((left, right) => left - right);
  return points.slice(0, -1).map((start, index) => {
    const end = points[index + 1];
    const active = marks.filter((mark) => mark.start <= start && mark.end >= end);
    const activeSemantics = semantics.filter((semantic) => semantic.start <= start && semantic.end >= end);
    let node: ReactNode = renderSegments(sliceSegments(segments, start, end));
    const ruby = activeSemantics.find((semantic) => semantic.kind === 'ruby' && semantic.value);
    if (ruby?.value) {
      node = (
        <ruby>
          {node}
          <rt>{ruby.value}</rt>
        </ruby>
      );
    }
    if (active.some((mark) => mark.kind === 'strong')) node = <strong>{node}</strong>;
    if (active.some((mark) => mark.kind === 'emphasis')) node = <em>{node}</em>;
    const language = activeSemantics.find((semantic) => semantic.kind === 'language' && semantic.value)?.value;
    if (language) node = <span lang={language}>{node}</span>;
    const link = active.find((mark) => mark.kind === 'link' && mark.href);
    const footnote = activeSemantics.some((semantic) => semantic.kind === 'footnote_reference');
    if (link?.href) {
      node = (
        <a
          href={link.href}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onLink(link.href!, footnote);
          }}
        >
          {node}
        </a>
      );
    }
    return <span key={`${start}:${end}`}>{node}</span>;
  });
}

function ReaderParagraphRowComponent({
  paragraph,
  virtualIndex,
  start,
  estimatedSize,
  isSpeaking,
  mode,
  searchQuery,
  decorationStore,
  measureElement,
  onSelectCorrectionSegment,
  assetRepository,
  onDocumentLink = () => undefined,
  staticLayout = false,
  sourceOffset = 0,
  sourceText,
}: ReaderParagraphRowProps) {
  const [imageReady, setImageReady] = useState(false);
  const subscribe = useCallback(
    (listener: () => void) => decorationStore.subscribe(paragraph.id, listener),
    [decorationStore, paragraph.id],
  );
  const getSnapshot = useCallback(() => decorationStore.getSnapshot(paragraph.id), [decorationStore, paragraph.id]);
  const decoration = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const showMeta = mode === 'analysis' || mode === 'correction';
  const needsReview = decoration.segments.some((segment) => decoration.reviewSegmentIds.has(segment.id));
  const decoratedText = useMemo(
    () =>
      decorateReaderText(
        paragraph.text,
        [...decoration.highlights],
        searchQuery,
        decoration.activeRanges.map((range) => ({ start: range.start - sourceOffset, end: range.end - sourceOffset })),
        sourceText === undefined ? undefined : { text: sourceText, offset: sourceOffset },
      ),
    [paragraph.text, decoration.highlights, decoration.activeRanges, searchQuery, sourceOffset, sourceText],
  );
  const composedText = useMemo(
    () => composePluginText(paragraph.text, decoratedText, decoration.pluginLayers ?? [], sourceOffset),
    [paragraph.text, decoratedText, decoration.pluginLayers, sourceOffset],
  );
  const textContent = useMemo(
    () => <InlineEpubText paragraph={paragraph} onLink={onDocumentLink} segments={composedText} />,
    [composedText, onDocumentLink, paragraph],
  );

  // Annotate the existing text element without adding wrappers or changing pagination layout.
  const textAnchor = {
    'data-reader-text': paragraph.id,
    'data-reader-book': paragraph.novelId,
    'data-reader-chapter': paragraph.chapterId,
    'data-reader-source-offset': sourceOffset,
  };
  const documentContent = (() => {
    if (paragraph.documentKind === 'image') {
      return (
        <EpubImage
          repository={assetRepository}
          bookId={paragraph.novelId}
          assetId={paragraph.assetId}
          alt={paragraph.text}
          onReady={() => setImageReady(true)}
        />
      );
    }
    if (paragraph.documentKind === 'heading') return <h2 {...textAnchor}>{textContent}</h2>;
    if (paragraph.documentKind === 'blockquote') return <blockquote {...textAnchor}>{textContent}</blockquote>;
    if (paragraph.documentKind === 'list_item')
      return (
        <p {...textAnchor} className="reader-list-item">
          {textContent}
        </p>
      );
    if (paragraph.documentKind === 'separator') return <hr />;
    return <p {...textAnchor}>{textContent}</p>;
  })();

  return (
    <div
      ref={measureElement}
      data-index={virtualIndex}
      className={classNames('reader-virtual-row', staticLayout && 'is-static')}
      style={
        staticLayout
          ? undefined
          : {
              transform: `translateY(${start}px)`,
              // Remounting an illustration must not replace its known height with a
              // short placeholder while its bytes and decoded image load again.
              minHeight: paragraph.documentKind === 'image' && !imageReady ? estimatedSize : undefined,
            }
      }
    >
      <div
        data-paragraph-id={paragraph.id}
        className={classNames(
          'reader-paragraph',
          isSpeaking && 'is-speaking',
          needsReview && showMeta && 'low-confidence',
          showMeta && 'with-meta',
          sourceOffset > 0 && 'is-continuation',
        )}
        onClick={() => {
          if (mode !== 'correction' || decoration.segments.length === 0) return;
          const segment =
            decoration.segments.find((item) => decoration.reviewSegmentIds.has(item.id)) ?? decoration.segments[0];
          onSelectCorrectionSegment(segment.id);
        }}
      >
        {showMeta && decoration.segments.length > 0 && (
          <div className="segment-meta">
            {decoration.segments.map((segment) =>
              mode === 'correction' ? (
                <button
                  key={segment.id}
                  type="button"
                  className={classNames(
                    decoration.correctionTargetId === segment.id && 'active',
                    decoration.reviewSegmentIds.has(segment.id) && 'needs-review',
                  )}
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelectCorrectionSegment(segment.id);
                  }}
                >
                  {segmentTypeLabel(segment)} · {speakerLabel(segment, decoration.characters)} ·{' '}
                  {Math.round(segment.confidence * 100)}%
                </button>
              ) : (
                <span key={segment.id}>
                  {segmentTypeLabel(segment)} · {speakerLabel(segment, decoration.characters)} ·{' '}
                  {Math.round(segment.confidence * 100)}%
                </span>
              ),
            )}
          </div>
        )}
        {documentContent}
      </div>
    </div>
  );
}

export const ReaderParagraphRow = memo(ReaderParagraphRowComponent);
