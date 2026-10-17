import { useEffect, useRef, useState } from 'react';
import {
  saveSourceReadingPreferences,
  sourceReadingPreferences,
  type SourceReadingPreferences,
} from '../../external-sources/source-reading-preferences';
import { SourceDownloadRecovery } from '../../features/external-sources/SourceDownloadRecovery';
import type { ExternalSourceController } from '../../features/external-sources/useExternalSourceController';
import { Segmented, Switch } from '../components/primitives';
import { Pref, PrefChips, PrefFold, PrefGroup } from '../components/prefs';
import './source-reading.css';

/** ui-next 소스에서 읽기: how source episodes open, what gets fetched ahead and what is cleaned up. */
export function UiNextSourceReadingSettings({
  controller,
  focus = false,
}: {
  controller: ExternalSourceController;
  focus?: boolean;
}) {
  const [prefs, setPrefs] = useState(sourceReadingPreferences);
  const [error, setError] = useState('');
  const sectionRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!focus) return;
    const frame = requestAnimationFrame(() => sectionRef.current?.scrollIntoView({ block: 'start' }));
    return () => cancelAnimationFrame(frame);
  }, [focus]);
  const change = (patch: Partial<SourceReadingPreferences>) => {
    try {
      saveSourceReadingPreferences(patch);
      setPrefs(sourceReadingPreferences());
      setError('');
    } catch {
      setError('설정을 저장하지 못했어요. 브라우저 저장 공간을 확인해 주세요.');
    }
  };
  const autoNext = controller.autoDownloadNext ?? false;
  const nextCount = controller.autoDownloadNextCount ?? 1;
  const retention = controller.downloadRetention;

  return (
    <section ref={sectionRef} className="un-source-reading" aria-labelledby="un-source-reading-title">
      <header className="un-source-reading-head">
        <h3 id="un-source-reading-title">소스에서 읽기</h3>
        <p>이 브라우저에 적용돼요. 서재에 저장한 회차는 캐시 설정과 관계없이 남아요.</p>
      </header>

      <PrefGroup>
        <Pref
          stacked
          title="소설 회차 열기"
          help={
            prefs.textMode === 'library'
              ? '서재에 저장한 뒤 열어요. 듣기·주석·목차·북마크를 내 작품처럼 쓸 수 있어요.'
              : '저장하지 않고 바로 읽어요. 듣기·주석은 쓸 수 없어요.'
          }
        >
          <Segmented
            label="소설 회차 열기"
            value={prefs.textMode}
            options={[
              { value: 'library', label: '서재에 저장해서 읽기' },
              { value: 'stream', label: '바로 읽기' },
            ]}
            onChange={(textMode) => change({ textMode })}
          />
        </Pref>
        <Pref
          stacked
          title="만화·웹툰 회차 열기"
          help={
            prefs.mode === 'stream'
              ? '저장하지 않고 바로 봐요. 다시 보려면 다시 불러와요.'
              : prefs.mode === 'stream-save'
                ? '바로 보면서 서재에도 저장해요. 다음에는 오프라인으로 볼 수 있어요.'
                : '회차를 다 받은 뒤 열어요. 느린 연결에서 끊김이 없어요.'
          }
        >
          <Segmented
            label="만화·웹툰 회차 열기"
            value={prefs.mode}
            options={[
              { value: 'stream', label: '바로 보기' },
              { value: 'stream-save', label: '보면서 저장' },
              { value: 'download', label: '받은 뒤 보기' },
            ]}
            onChange={(mode) => change({ mode })}
          />
        </Pref>
        <Pref
          stacked
          title="이미지 미리 불러오기"
          help="보는 화면 앞뒤로 준비할 장수예요. 데이터 절약 모드에서는 꺼져요."
        >
          <PrefChips
            label="이미지 미리 불러오기"
            value={prefs.prefetch}
            options={[
              { value: 0, label: '끔' },
              { value: 2, label: '2장' },
              { value: 4, label: '4장' },
              { value: 5, label: '5장' },
              { value: 8, label: '8장' },
              { value: 10, label: '10장' },
            ]}
            onChange={(prefetch) => change({ prefetch })}
          />
        </Pref>
      </PrefGroup>

      <PrefGroup>
        <Pref
          title="다음 회차 미리 받기"
          help="회차를 읽기 시작하면 다음 회차를 서재에 받아 둬요."
          control={
            <Switch
              label="다음 회차 미리 받기"
              checked={autoNext}
              onChange={(checked) => controller.setAutoDownloadNext?.(checked)}
            />
          }
        />
        {autoNext && (
          <Pref
            title="미리 받을 회차 수"
            control={
              <Segmented
                label="미리 받을 회차 수"
                value={String(nextCount) as '1' | '2' | '3'}
                options={[
                  { value: '1', label: '1화' },
                  { value: '2', label: '2화' },
                  { value: '3', label: '3화' },
                ]}
                onChange={(value) => controller.setAutoDownloadNextCount?.(Number(value) as 1 | 2 | 3)}
              />
            }
          />
        )}
        {retention && (
          <>
            <Pref
              title="읽은 회차 자동 정리"
              help="리더를 나온 뒤 오래전에 읽은 회차를 지워요. 즐겨찾기·안 읽은 회차·가져온 파일은 남겨요."
              control={
                <Switch
                  label="읽은 회차 자동 정리"
                  checked={retention.enabled}
                  onChange={(checked) => !retention.busy && retention.setEnabled(checked)}
                />
              }
            />
            {retention.enabled && (
              <Pref
                title="정리 전 더 읽을 회차 수"
                help={`${retention.keep}화를 더 읽으면 그 앞 회차를 정리해요.`}
                control={
                  <Segmented
                    label="정리 전 더 읽을 회차 수"
                    value={String(retention.keep) as '5' | '10' | '20'}
                    options={[
                      { value: '5', label: '5화' },
                      { value: '10', label: '10화' },
                      { value: '20', label: '20화' },
                    ]}
                    onChange={(value) => !retention.busy && retention.setKeep(Number(value) as 5 | 10 | 20)}
                  />
                }
              />
            )}
          </>
        )}
      </PrefGroup>

      <PrefFold title="캐시" summary="목록·표지·이미지를 다시 쓰는 시간">
        <Pref stacked title="목록·작품 정보" help="지나면 다시 확인해요. 새로고침하면 바로 반영돼요.">
          <PrefChips
            label="목록·작품 정보 재사용 시간"
            value={prefs.listMinutes}
            options={[
              { value: 0, label: '안 함' },
              { value: 2, label: '2분' },
              { value: 30, label: '30분' },
              { value: 360, label: '6시간' },
            ]}
            onChange={(listMinutes) => change({ listMinutes })}
          />
        </Pref>
        <Pref stacked title="표지 이미지">
          <PrefChips
            label="표지 이미지 재사용 시간"
            value={prefs.coverHours}
            options={[
              { value: 0, label: '안 함' },
              { value: 1, label: '1시간' },
              { value: 24, label: '1일' },
              { value: 168, label: '1주' },
              { value: 720, label: '30일' },
              { value: 2160, label: '90일' },
            ]}
            onChange={(coverHours) => change({ coverHours })}
          />
        </Pref>
        <Pref stacked title="보는 이미지 임시 보관" help="서버 메모리에 최대 64MB까지만 보관하고 저장하지 않아요.">
          <PrefChips
            label="보는 이미지 임시 보관 시간"
            value={prefs.imageMinutes}
            options={[
              { value: 0, label: '안 함' },
              { value: 2, label: '2분' },
              { value: 10, label: '10분' },
            ]}
            onChange={(imageMinutes) => change({ imageMinutes })}
          />
        </Pref>
      </PrefFold>

      {error && (
        <p className="un-pref-error" role="alert">
          {error}
        </p>
      )}

      <SourceDownloadRecovery controller={controller} />
    </section>
  );
}
