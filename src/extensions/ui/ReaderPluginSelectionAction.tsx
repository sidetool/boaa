import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Puzzle } from 'lucide-react';
import { Dialog } from '../../shared/ui/Dialog';
import { useReaderPlugins } from './ReaderPluginProvider';
import type { SelectionCapture } from './runtime-commands';
import type { ReaderAddonTab } from '../../features/reader/reader-screen-contract';
import { readerPluginError } from './reader-plugin-errors';
export function ReaderPluginSelectionAction({
  capture,
  open,
  clear,
}: {
  capture: () => SelectionCapture | undefined;
  open: (tab: ReaderAddonTab) => void;
  clear: () => void;
}) {
  const { host, snapshot } = useReaderPlugins();
  const [selected, setSelected] = useState<{ value?: SelectionCapture; error?: string }>();
  useEffect(() => {
    setSelected(undefined);
  }, [host, snapshot.reader?.key]);
  const entries = snapshot.entries.filter((entry) => entry.commands.length);
  if (!host || !entries.length || !snapshot.reader) return null;
  return (
    <>
      <button
        type="button"
        className="mini-icon-btn"
        title="선택 문장 플러그인에 공유"
        aria-label="선택 문장 플러그인에 공유"
        onClick={() => {
          const value = capture();
          setSelected(value ? { value } : { error: 'TXT·EPUB의 한 문단 안에서 글을 다시 선택해 주세요.' });
        }}
      >
        <Puzzle size={15} />
      </button>
      {selected &&
        createPortal(
          <div onMouseDown={(event) => event.stopPropagation()}>
            <Dialog open title="선택한 글 공유" onClose={() => setSelected(undefined)}>
              {selected.error && <p role="alert">{selected.error}</p>}
              {selected.value && (
                <>
                  <p className="reader-plugin-selection-preview">{selected.value.selection.text}</p>
                  <p>선택한 글을 아래 플러그인에 전달합니다.</p>
                  <div className="reader-plugin-commands">
                    {entries.flatMap((entry) =>
                      entry.commands.map((command) => (
                        <button
                          type="button"
                          key={command.id}
                          onClick={() => {
                            try {
                              host.share(entry, command.id, selected.value!);
                              open(entry.tab.id);
                              setSelected(undefined);
                              clear();
                            } catch (error) {
                              setSelected({ ...selected, error: readerPluginError(error) });
                            }
                          }}
                        >
                          <strong>{entry.tab.label}</strong>
                          <span>{command.title}</span>
                        </button>
                      )),
                    )}
                  </div>
                </>
              )}
            </Dialog>
          </div>,
          document.body,
        )}
    </>
  );
}
