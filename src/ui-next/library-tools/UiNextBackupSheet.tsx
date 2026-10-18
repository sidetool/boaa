import { ArchiveRestore, DatabaseBackup, FileArchive, Upload } from 'lucide-react';
import { useRef } from 'react';
import { taskProgressDetail, taskProgressLabel, taskProgressPercent } from '../../components/task-progress';
import { useSelfHostCapability } from '../../features/auth/self-host-account-api';
import type { BackupFeatureController } from '../../features/backup/useBackupController';
import type { BackupConflictResolution } from '../../repositories/backup-repository';
import { formatBytes, formatCount } from '../../utils/format';
import { Progress, Sheet } from '../components/primitives';
import { EmptyState, Notice, Pref, PrefGroup, PrefSection } from '../components/prefs';
import './library-tools.css';

const RESOLUTION: readonly { value: BackupConflictResolution; label: string }[] = [
  { value: 'skip', label: '있는 책 그대로' },
  { value: 'replace', label: '백업으로 바꾸기' },
  { value: 'copy', label: '하나 더 추가' },
];

function ResolutionSelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: BackupConflictResolution;
  onChange(value: BackupConflictResolution): void;
}) {
  return (
    <select
      className="un-select"
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value as BackupConflictResolution)}
    >
      {RESOLUTION.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/** 백업과 복원: one ZIP with books, originals, positions, notes and settings; restore checks the file first. */
export default function UiNextBackupSheet({ controller }: { controller: BackupFeatureController }) {
  const input = useRef<HTMLInputElement>(null);
  const { inspection, progress } = controller;
  // Members can take their own library out; restoring stays with the administrator in this release.
  const canExport = useSelfHostCapability('exportLibrary');
  const canRestore = useSelfHostCapability('restoreLibrary');
  const percent = taskProgressPercent(progress);
  const label = progress ? taskProgressLabel(progress) : '준비 중';
  const detail = taskProgressDetail(progress);
  const doing =
    controller.operation === 'export'
      ? '백업 만드는 중'
      : controller.operation === 'restore'
        ? '복원하는 중'
        : '파일 확인 중';

  return (
    <Sheet
      open={controller.open}
      onClose={controller.closePanel}
      closeDisabled={controller.busy}
      title={canRestore ? '백업과 복원' : '백업'}
      footer={
        inspection && canRestore ? (
          <button
            type="button"
            className="un-btn is-primary un-tools-wide"
            disabled={controller.busy}
            onClick={() => void controller.restoreBackup()}
          >
            <ArchiveRestore size={17} />
            확인한 백업 복원하기
          </button>
        ) : undefined
      }
    >
      {!controller.available ? (
        <EmptyState
          icon={<DatabaseBackup size={22} />}
          title="여기서는 전체 백업을 쓸 수 없어요"
          body="기기 서재에서 백업을 만들거나 서버 관리 기능을 확인해 주세요."
        />
      ) : (
        <div className="un-tools">
          {controller.busy && (
            <div className="un-tools-card is-running" role="status" aria-live="polite">
              <div className="un-tools-running-head">
                <strong>{doing}</strong>
                {percent !== undefined && <span>{Math.round(percent)}%</span>}
              </div>
              {percent !== undefined && <Progress value={percent / 100} label={label} />}
              <small>
                {label}
                {detail ? ` · ${detail}` : ''}
              </small>
              <small>끝날 때까지 이 창을 닫을 수 없어요.</small>
            </div>
          )}

          <PrefGroup>
            {canExport && (
              <Pref
                title="백업 만들기"
                help="책, 원본, 읽던 위치, 주석, 설정을 ZIP 하나로 저장해요."
                control={
                  <button
                    type="button"
                    className="un-btn is-primary is-sm"
                    disabled={controller.busy}
                    onClick={() => void controller.exportBackup()}
                  >
                    <DatabaseBackup size={15} />
                    만들기
                  </button>
                }
              />
            )}
            {canRestore && (
              <Pref
                title="백업에서 복원"
                help="파일을 먼저 확인하고, 겹치는 책은 어떻게 할지 골라요."
                control={
                  <button
                    type="button"
                    className="un-btn is-ghost is-sm"
                    disabled={controller.busy}
                    onClick={() => {
                      if (controller.usesPlatformPicker) void controller.pickBackupFile();
                      else input.current?.click();
                    }}
                  >
                    <Upload size={15} />
                    파일 고르기
                  </button>
                }
              />
            )}
          </PrefGroup>
          {!canRestore && (
            <Notice>백업에서 복원하기는 지금은 서버 관리자만 할 수 있어요. 내 백업 파일은 보관해 두세요.</Notice>
          )}
          <input
            ref={input}
            type="file"
            accept=".zip,application/zip"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void controller.inspectFile(file);
            }}
          />

          {inspection && canRestore && (
            <PrefSection title="확인한 백업">
              <div className="un-tools-card un-tools-file">
                <FileArchive size={20} aria-hidden="true" />
                <div>
                  <strong>{formatCount(inspection.manifest.books.length)}권</strong>
                  <small>
                    {formatBytes(inspection.archiveByteLength)} · 풀면 {formatBytes(inspection.totalUncompressedBytes)}
                  </small>
                </div>
              </div>
              {inspection.warnings.map((warning) => (
                <Notice key={warning} tone="warning">
                  {warning}
                </Notice>
              ))}
              {inspection.conflicts.length > 0 && (
                <>
                  <PrefGroup>
                    <Pref
                      title={`서재에 이미 있는 책 ${formatCount(inspection.conflicts.length)}권`}
                      help="한꺼번에 정하고, 필요한 책만 아래에서 따로 바꿔요."
                      control={
                        <ResolutionSelect
                          label="겹치는 책 기본 처리"
                          value={controller.defaultResolution}
                          onChange={controller.setDefaultResolution}
                        />
                      }
                    />
                  </PrefGroup>
                  <PrefGroup>
                    {inspection.conflicts.map((conflict) => (
                      <Pref
                        key={conflict.bookId}
                        title={conflict.title}
                        control={
                          <ResolutionSelect
                            label={`${conflict.title} 처리`}
                            value={controller.conflictResolutions[conflict.bookId] ?? controller.defaultResolution}
                            onChange={(value) => controller.setConflictResolution(conflict.bookId, value)}
                          />
                        }
                      />
                    ))}
                  </PrefGroup>
                </>
              )}
            </PrefSection>
          )}
        </div>
      )}
    </Sheet>
  );
}
