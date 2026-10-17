import { isUiJson, type UiJson } from '@boaa/extension-contracts/ui-json';
import { ReaderPluginDecorationLayers } from '../../reader/plugin-decoration-layers';
export interface PluginReaderContent {
  readonly key: string;
  readonly bookId: string;
  readonly chapterId: string;
  readonly contentRevision: string;
  readonly theme: string;
  readonly blocks: readonly { id: string; text: string; textHash: string }[];
}
export interface DecorationPlan {
  id: string;
  key: string;
  configRevision: number;
  run: (content: PluginReaderContent, signal: AbortSignal) => Promise<UiJson>;
}
/** One latest batch, one compute invocation at a time. Owns only its Reader's paint store. */
export class ReaderDecorationRuntime {
  private content?: PluginReaderContent;
  private contentKey = '';
  private plans = new Map<string, DecorationPlan>();
  private completed = new Map<string, string>();
  private errors = new Map<string, string>();
  private current?: { id: string; abort: AbortController };
  private working = false;
  private closed = false;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private layers: ReaderPluginDecorationLayers) {}
  status() {
    return { working: this.working, errors: Object.fromEntries(this.errors), contentKey: this.content?.key };
  }
  update(content?: PluginReaderContent) {
    if (this.closed) return;
    const valid = !content || (content.blocks.length <= 64 && isUiJson(content, 48 * 1024));
    const key = valid && content ? JSON.stringify(content) : '';
    if (key === this.contentKey && valid) return;
    this.current?.abort.abort();
    const previous = this.content;
    const sameReader =
      valid &&
      content &&
      previous &&
      ['key', 'bookId', 'chapterId', 'contentRevision', 'theme'].every(
        (k) => content[k as keyof PluginReaderContent] === previous[k as keyof PluginReaderContent],
      );
    if (!sameReader) this.layers.reset();
    this.completed.clear();
    this.errors.clear();
    this.contentKey = key;
    this.content = valid && content ? (JSON.parse(key) as PluginReaderContent) : undefined;
    if (!valid) this.errors.set('$reader', 'CONTENT_LIMIT');
    this.schedule();
  }
  refresh(plans: DecorationPlan[]) {
    if (this.closed) return;
    if (plans.length === this.plans.size && plans.every((plan) => this.plans.get(plan.id) === plan)) return;
    const next = new Map(plans.map((plan) => [plan.id, plan]));
    for (const [id, old] of this.plans) if (next.get(id)?.key !== old.key) this.invalidate(id);
    this.plans = next;
    this.schedule();
  }
  invalidate(id: string) {
    if (this.current?.id === id) this.current.abort.abort();
    this.layers.remove(id);
    this.completed.delete(id);
    this.errors.delete(id);
    this.plans.delete(id);
  }
  private schedule() {
    if (this.closed || this.working || this.timer || !this.content) return;
    if (![...this.plans.values()].some((p) => this.completed.get(p.id) !== p.key)) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.drain();
    }, 50);
  }
  private async drain() {
    if (this.closed || this.working) return;
    this.working = true;
    try {
      const ordered = [...this.plans.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      for (const plan of ordered) {
        const content = this.content;
        if (this.closed || !content) break;
        if (this.plans.get(plan.id)?.key !== plan.key || this.completed.get(plan.id) === plan.key) continue;
        this.completed.set(plan.id, plan.key);
        const abort = new AbortController();
        this.current = { id: plan.id, abort };
        try {
          const lease = this.layers.prepare(
            plan.id,
            0,
            content.blocks.map(({ id, text }) => ({ id, text })),
            true,
          );
          const output = await plan.run(content, abort.signal);
          if (
            this.closed ||
            abort.signal.aborted ||
            this.content !== content ||
            this.plans.get(plan.id)?.key !== plan.key
          )
            continue;
          this.layers.replace(lease, output);
        } catch (error) {
          if (
            !this.closed &&
            !abort.signal.aborted &&
            this.content === content &&
            this.plans.get(plan.id)?.key === plan.key
          ) {
            this.layers.remove(plan.id);
            this.errors.set(plan.id, error instanceof Error ? error.message : 'DECORATION_FAILED');
          }
        } finally {
          if (this.current?.abort === abort) this.current = undefined;
        }
      }
    } finally {
      this.working = false;
      this.schedule();
    }
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.current?.abort.abort();
    this.plans.clear();
    this.completed.clear();
    this.content = undefined;
    this.layers.reset();
    this.errors.clear();
  }
}
