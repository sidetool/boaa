import { isUiJson, uiKeys, uiRecord, type UiJson } from '@boaa/extension-contracts/ui-json';
import { ReaderPluginDecorationLayers } from '../../reader/plugin-decoration-layers';
import type { PluginReaderAdapter } from './reader-session';
import type { PluginReaderContent } from './reader-decoration-runtime';
import { requireStore } from '../ui/store-model';

type Block = PluginReaderContent['blocks'][number];
interface Position {
  page: number;
  offset: number;
  index: number;
}
interface Layer {
  id: string;
  palette: Record<string, UiJson>;
  ranges: Array<{ paragraphId: string; start: number; end: number; styleId: string }>;
}
interface Checkpoint {
  position: Position;
  state: UiJson;
}
/** Ephemeral, per-controller and per-reader cache. No authored parser logic lives here. */
export class OrderedDecoration {
  private key = '';
  private checkpoints: Checkpoint[] = [];
  clear() {
    this.key = '';
    this.checkpoints = [];
  }
  async run(
    key: string,
    content: PluginReaderContent,
    adapter: PluginReaderAdapter,
    signal: AbortSignal,
    guard: () => Promise<void>,
    invoke: (blocks: readonly Block[], state: UiJson) => Promise<UiJson>,
  ): Promise<UiJson> {
    const context = JSON.stringify([
      key,
      content.key,
      content.bookId,
      content.chapterId,
      content.contentRevision,
      content.theme,
      adapter.chapters.find((chapter) => chapter.id === content.chapterId)?.textHash,
    ]);
    if (this.key !== context) {
      this.key = context;
      this.checkpoints = [];
    }
    const check = async () => {
      signal.throwIfAborted();
      requireStore(
        this.key === context &&
          adapter.bookId === content.bookId &&
          adapter.chapterId === content.chapterId &&
          adapter.contentRevision === content.contentRevision,
        'READER_CONTEXT_STALE',
      );
      await guard();
      const book = await adapter.repository.getNovel(content.bookId);
      signal.throwIfAborted();
      requireStore(
        this.key === context && book?.activeContentRevisionId === content.contentRevision && !book.deletedAt,
        'CONTENT_CHANGED',
      );
    };
    await check();
    if (!content.blocks.length) return { layers: [] };
    const targets = new Map(content.blocks.map((block) => [block.id, block]));
    const first = await adapter.repository.getParagraph(content.blocks[0].id, signal);
    await check();
    requireStore(
      first?.novelId === content.bookId &&
        first.chapterId === content.chapterId &&
        first.textHash === content.blocks[0].textHash,
      'CONTENT_CHANGED',
    );
    const saved = [...this.checkpoints].reverse().find((entry) => entry.position.index <= first.index);
    const position: Position = saved ? { ...saved.position } : { page: 0, offset: 0, index: 0 };
    let state: UiJson = saved ? JSON.parse(JSON.stringify(saved.state)) : {};
    // Compose validated styles from visited batches only for the visible/nearby targets.
    const layers = new Map<string, { value: Layer; styles: Map<string, string> }>();
    let rangeCount = 0;
    const found = new Set<string>();
    let reads = 0;
    const deadline = Date.now() + 30000;
    while (found.size < targets.size) {
      await check();
      requireStore(++reads <= 4096 && Date.now() < deadline, 'ORDERED_CONTENT_LIMIT');
      const page = await adapter.repository.getParagraphPage(content.chapterId, position.page, signal);
      await check();
      requireStore(
        page &&
          page.novelId === content.bookId &&
          page.chapterId === content.chapterId &&
          page.pageIndex === position.page,
        'CONTENT_CHANGED',
      );
      const blocks: Block[] = [];
      while (position.offset < page.paragraphs.length && blocks.length < 16) {
        const paragraph = page.paragraphs[position.offset];
        requireStore(
          paragraph.novelId === content.bookId &&
            paragraph.chapterId === content.chapterId &&
            Number.isSafeInteger(paragraph.index) &&
            paragraph.index >= position.index,
          'CONTENT_CHANGED',
        );
        const block = { id: paragraph.id, text: paragraph.text, textHash: paragraph.textHash };
        if (!isUiJson([...blocks, block], 40 * 1024)) {
          requireStore(blocks.length, 'CONTENT_LIMIT');
          break;
        }
        blocks.push(block);
        position.offset++;
        position.index = paragraph.index + 1;
      }
      requireStore(blocks.length, 'CONTENT_CHANGED');
      if (position.offset === page.paragraphs.length) {
        position.page++;
        position.offset = 0;
      }
      const result = await invoke(blocks, state);
      await check();
      requireStore(
        uiRecord(result) && uiKeys(result, ['layers', 'checkpoints']) && isUiJson(result.checkpoints, 8192),
        'INVALID_CHECKPOINT',
      );
      const paint = { layers: result.layers };
      // Reuse the real Reader validator for ALL ranges, including off-screen ones.
      const validation = new ReaderPluginDecorationLayers(() => {});
      validation.replace(
        validation.prepare(
          'ordered',
          0,
          blocks.map(({ id, text }) => ({ id, text })),
        ),
        paint,
      );
      for (const block of blocks) {
        const target = targets.get(block.id);
        if (!target) continue;
        requireStore(target.text === block.text && target.textHash === block.textHash, 'CONTENT_CHANGED');
        found.add(block.id);
      }
      for (const layer of result.layers as unknown as Layer[]) {
        let merged = layers.get(layer.id);
        if (!merged) {
          merged = { value: { id: layer.id, palette: {}, ranges: [] }, styles: new Map() };
          layers.set(layer.id, merged);
        }
        for (const range of layer.ranges) {
          if (!targets.has(range.paragraphId)) continue;
          const serialized = JSON.stringify(layer.palette[range.styleId]);
          let styleId = merged.styles.get(serialized);
          if (!styleId) {
            styleId = `s${merged.styles.size}`;
            merged.styles.set(serialized, styleId);
            merged.value.palette[styleId] = JSON.parse(serialized);
          }
          requireStore(merged.styles.size <= 16 && ++rangeCount <= 1024, 'DECORATION_LIMIT');
          merged.value.ranges.push({ ...range, styleId });
        }
      }
      state = JSON.parse(JSON.stringify(result.checkpoints));
      // Keep sorted checkpoints, bounded independently of chapter length.
      this.checkpoints = this.checkpoints.filter((entry) => entry.position.index !== position.index);
      this.checkpoints.push({ position: { ...position }, state });
      this.checkpoints.sort((a, b) => a.position.index - b.position.index);
      if (this.checkpoints.length > 64) this.checkpoints.shift();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    await check();
    const output = JSON.parse(JSON.stringify({ layers: [...layers.values()].map((layer) => layer.value) }));
    requireStore(isUiJson(output, 64 * 1024), 'DECORATION_LIMIT');
    return output;
  }
}
