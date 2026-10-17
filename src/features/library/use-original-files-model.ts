import { useEffect, useRef, useState } from 'react';
import type { OriginalFileEntry } from '@boaa/contracts';
import type { BookAssetRepository } from '../../repositories/book-asset-repository';
export interface OriginalFilesModelOptions {
  book: { id: string };
  repository: BookAssetRepository;
}
export function useOriginalFilesModel({ book, repository }: OriginalFilesModelOptions) {
  const [files, setFiles] = useState<readonly OriginalFileEntry[] | null>();
  const [error, setError] = useState<'list_failed' | 'download_failed'>();
  const [pending, setPending] = useState<string>();
  const [requested, setRequested] = useState(false);
  const [reload, setReload] = useState(0);
  const [visible, setVisible] = useState(30);
  const generation = useRef({ value: 0 }).current;
  useEffect(() => {
    const run = ++generation.value;
    const abort = new AbortController();
    setFiles(undefined);
    setError(undefined);
    setPending(undefined);
    setRequested(false);
    setVisible(30);
    void repository.listOriginalFiles!(book.id, abort.signal).then(
      (result) => {
        if (generation.value === run) setFiles(result);
      },
      () => {
        if (generation.value === run) setError('list_failed');
      },
    );
    return () => {
      generation.value = run + 1;
      abort.abort();
    };
  }, [repository, book.id, reload, generation]);

  async function download(file: OriginalFileEntry) {
    const run = generation.value;
    setPending(file.id);
    setError(undefined);
    try {
      const url = await repository.createOriginalFileDownload!(book.id, file.id);
      if (generation.value !== run) return;
      const link = document.createElement('a');
      link.href = url;
      link.download = file.fileName;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      document.body.append(link);
      link.click();
      link.remove();
      // Completion/cancellation belongs to the browser download manager.
      setRequested(true);
    } catch {
      if (generation.value === run) setError('download_failed');
    } finally {
      if (generation.value === run) setPending(undefined);
    }
  }
  const refresh = () => setReload((n) => n + 1);
  const showMore = () => setVisible((n) => n + 30);
  const downloadAll = () =>
    download({
      id: '__all__',
      fileName: 'original-files.zip',
      contentType: 'application/zip',
      byteLength: 0,
      contentHash: '',
    });
  return { files, error, pending, requested, visible, refresh, showMore, download, downloadAll };
}
export type OriginalFilesModel = ReturnType<typeof useOriginalFilesModel>;
