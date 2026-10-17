import { Download, FilePenLine, RotateCcw, Trash2 } from 'lucide-react';
import { bookFormatLabel, bookUnitLabel, isFixedDocumentFormat } from '../../domain/book-format';
import type { Novel } from '../../domain/types';
import type { ExternalSourceController } from '../../features/external-sources/external-source-controller-contract';
import { useSourceWorkManagementModel } from '../../features/external-sources/use-source-work-management-model';
import type { LibraryScreenProps } from '../../features/library/library-screen-contract';
import { formatReadingDuration } from '../../features/library/library-screen-model';
import { formatBytes, formatCount } from '../../utils/format';
import { Pref, PrefFold, PrefLink } from '../components/prefs';

const value = (text: string) => <span className="un-pref-value">{text}</span>;

/** 작품 관리: file facts, reading time and the few actions that change the work itself. */
export function SourceWorkTools({
  novel,
  controller,
  library,
}: {
  novel?: Novel;
  controller: ExternalSourceController;
  library: LibraryScreenProps;
}) {
  const model = useSourceWorkManagementModel({ novel, controller, library });
  const reading =
    model.seconds === undefined
      ? model.time?.id === model.id
        ? '알 수 없음'
        : '확인 중'
      : model.seconds > 0
        ? formatReadingDuration(model.seconds)
        : '기록 없음';
  const fixed = novel ? isFixedDocumentFormat(novel.format) : false;
  return (
    <PrefFold title="작품 관리" summary="파일 정보, 읽은 기록, 휴지통">
      {novel ? (
        <>
          <Pref title="원본 파일" help={novel.sourceFileName} />
          {novel.sourceByteLength !== undefined && (
            <Pref title="원본 크기" control={value(formatBytes(novel.sourceByteLength))} />
          )}
          <Pref title="형식" control={value(bookFormatLabel(novel))} />
          <Pref title={bookUnitLabel(novel)} control={value(`${formatCount(novel.totalChapters)}개`)} />
          {!fixed && <Pref title="분량" control={value(`${formatCount(novel.totalCharacters)}자`)} />}
        </>
      ) : (
        <>
          <Pref title="원본 파일" control={value('바로 읽기 · 저장한 파일 없음')} />
          <Pref
            title="전체 회차"
            control={value(String(controller.activeSubscription?.availableReleaseCount ?? '알 수 없음'))}
          />
        </>
      )}
      {model.id && (!novel || (model.seconds ?? 0) > 0) && (
        <Pref title={novel ? '바로 읽은 시간 · 이 기기' : '읽은 시간 · 이 기기'} control={value(reading)} />
      )}
      {novel && (
        <>
          <PrefLink icon={<FilePenLine size={16} />} title="작품 정보 편집" onClick={model.editMetadata} />
          <PrefLink
            icon={<Download size={16} />}
            title="원본 받기"
            disabled={!novel.sourceAssetId}
            onClick={() => void model.downloadSource()}
          />
        </>
      )}
      <PrefLink
        icon={<RotateCcw size={16} />}
        title="읽은 기록 지우기"
        disabled={model.resetDisabled}
        onClick={() => void model.resetHistory()}
      />
      {(novel || controller.activeSubscription) && (
        <PrefLink
          icon={<Trash2 size={16} />}
          title="휴지통으로"
          danger
          disabled={model.removeDisabled}
          onClick={model.remove}
        />
      )}
    </PrefFold>
  );
}
