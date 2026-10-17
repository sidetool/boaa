import { isUiJson, uiRecord, uiKeys, uiInteger, uiString } from '@boaa/extension-contracts/ui-json';
export interface PluginTextStyle {
  color?: string;
  backgroundColor?: string;
  underline?: boolean;
  strikethrough?: boolean;
  fontWeight?: number;
  fontStyle?: 'normal' | 'italic';
}
export interface PluginTextRange {
  start: number;
  end: number;
  style: Readonly<PluginTextStyle>;
}
export interface PluginParagraphLayer {
  readonly text: string;
  readonly ranges: readonly PluginTextRange[];
}
export interface PluginDecorationLease {
  readonly job: string;
}
interface Owner {
  lease: PluginDecorationLease;
  order: number;
  texts: Map<string, string>;
  result: Map<string, PluginTextRange[]>;
  used: boolean;
  retained?: Owner;
}
let nextLayoutSession = 0;
const empty: readonly PluginParagraphLayer[] = Object.freeze([]);
const identifier = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(v);
function check(condition: unknown): asserts condition {
  if (!condition) throw Error('INVALID_PLUGIN_DECORATION');
}
// Use grapheme boundaries, not only surrogate pairs. Unsupported engines decline decoration safely.
function boundaries(text: string): Set<number> {
  type SegmenterConstructor = new (
    locale: undefined,
    options: { granularity: 'grapheme' },
  ) => { segment(text: string): Iterable<{ index: number }> };
  const Segmenter = (Intl as unknown as { Segmenter?: SegmenterConstructor }).Segmenter;
  check(Segmenter);
  return new Set([
    text.length,
    ...Array.from(new Segmenter(undefined, { granularity: 'grapheme' }).segment(text), (s) => s.index),
  ]);
}
/** Trusted Reader host only. A lease is an opaque, one-shot job identity, NOT a plugin permission. */
export class ReaderPluginDecorationLayers {
  private owners = new Map<string, Owner>();
  private snapshots = new Map<string, readonly PluginParagraphLayer[]>();
  private layoutRevision = 0;
  private layoutFingerprint = '';
  private layoutListeners = new Set<() => void>();
  readonly layoutSession = ++nextLayoutSession;
  readonly getLayoutRevision = () => this.layoutRevision;
  readonly subscribeLayout = (listener: () => void) => {
    this.layoutListeners.add(listener);
    return () => {
      this.layoutListeners.delete(listener);
    };
  };
  constructor(private changed: (ids: ReadonlySet<string>) => void) {}
  getSnapshot(id: string): readonly PluginParagraphLayer[] {
    return this.snapshots.get(id) ?? empty;
  }
  prepare(
    owner: string,
    order: number,
    blocks: readonly { id: string; text: string }[],
    retain = false,
  ): PluginDecorationLease {
    check(identifier(owner));
    const previous = retain ? this.owners.get(owner) : undefined;
    if (!retain) this.remove(owner);
    check(Number.isSafeInteger(order) && Math.abs(order) <= 10000 && (this.owners.has(owner) || this.owners.size < 16));
    check(isUiJson(blocks, 65536) && blocks.length <= 64);
    const texts = new Map<string, string>();
    for (const block of blocks) {
      check(
        uiRecord(block) &&
          uiKeys(block, ['id', 'text']) &&
          uiString(block.id, 1024) &&
          typeof block.text === 'string' &&
          !texts.has(block.id),
      );
      texts.set(block.id, block.text);
    }
    const lease = Object.freeze({ job: crypto.randomUUID() });
    this.owners.set(owner, {
      lease,
      order,
      texts,
      result: new Map(),
      used: false,
      retained: previous?.used ? previous : previous?.retained,
    });
    return lease;
  }
  replace(lease: PluginDecorationLease, value: unknown): void {
    const record = [...this.owners.values()].find((owner) => owner.lease === lease);
    if (!record || record.used) throw Error('STALE_PLUGIN_DECORATION');
    record.used = true;
    check(
      isUiJson(value, 65536) &&
        uiRecord(value) &&
        uiKeys(value, ['layers']) &&
        Array.isArray(value.layers) &&
        value.layers.length <= 8,
    );
    const result = new Map<string, PluginTextRange[]>();
    const names = new Set<string>();
    let count = 0;
    const edges = new Map<string, Set<number>>();
    // Stable layer ID order, independent of object enumeration or plugin reply timing.
    const layers = value.layers.map((layer): Record<string, unknown> & { id: string } => {
      check(uiRecord(layer) && identifier(layer.id));
      return { ...layer, id: layer.id };
    });
    layers.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const layer of layers) {
      check(
        uiRecord(layer) && uiKeys(layer, ['id', 'palette', 'ranges']) && identifier(layer.id) && !names.has(layer.id),
      );
      names.add(layer.id);
      check(uiRecord(layer.palette) && Object.keys(layer.palette).length <= 16 && Array.isArray(layer.ranges));
      const palette = new Map<string, PluginTextStyle>();
      for (const [id, style] of Object.entries(layer.palette)) {
        check(
          identifier(id) &&
            uiRecord(style) &&
            uiKeys(style, [], ['color', 'backgroundColor', 'underline', 'strikethrough', 'fontWeight', 'fontStyle']) &&
            Object.keys(style).length > 0,
        );
        for (const key of ['color', 'backgroundColor'])
          check(
            style[key] === undefined ||
              (typeof style[key] === 'string' && /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(style[key])),
          );
        for (const key of ['underline', 'strikethrough'])
          check(style[key] === undefined || typeof style[key] === 'boolean');
        check(
          style.fontWeight === undefined || (uiInteger(style.fontWeight, 100, 900) && style.fontWeight % 100 === 0),
        );
        check(style.fontStyle === undefined || style.fontStyle === 'normal' || style.fontStyle === 'italic');
        palette.set(id, Object.freeze({ ...style }));
      }
      for (const range of layer.ranges) {
        check(
          ++count <= 1024 &&
            uiRecord(range) &&
            uiKeys(range, ['paragraphId', 'start', 'end', 'styleId']) &&
            typeof range.paragraphId === 'string' &&
            typeof range.styleId === 'string',
        );
        const text = record.texts.get(range.paragraphId),
          style = palette.get(range.styleId);
        check(
          text !== undefined &&
            style &&
            uiInteger(range.start, 0, text.length) &&
            uiInteger(range.end, range.start + 1, text.length),
        );
        let points = edges.get(range.paragraphId);
        if (!points) {
          points = boundaries(text);
          edges.set(range.paragraphId, points);
        }
        check(points.has(range.start) && points.has(range.end));
        const ranges = result.get(range.paragraphId) ?? [];
        ranges.push(Object.freeze({ start: range.start, end: range.end, style }));
        result.set(range.paragraphId, ranges);
      }
    }
    // Retain a bounded display cache within the same Reader/configuration only.
    // Hidden paragraphs do not get sent back to the guest; their previous output stabilizes page measurements.
    const retained = record.retained;
    if (retained) {
      const encoder = new TextEncoder();
      let cacheBytes = encoder.encode(JSON.stringify([...record.texts])).byteLength;
      for (const [id, ranges] of retained.result) {
        if (record.texts.has(id) || result.size >= 128) continue;
        if (count + ranges.length > 1024) continue;
        const bytes = encoder.encode(JSON.stringify([id, retained.texts.get(id)!])).byteLength + 1;
        if (cacheBytes + bytes > 128 * 1024) continue;
        cacheBytes += bytes;
        count += ranges.length;
        result.set(id, ranges);
        record.texts.set(id, retained.texts.get(id)!);
      }
    }
    record.retained = undefined;
    let total = count;
    const perParagraph = new Map([...result].map(([id, ranges]) => [id, ranges.length]));
    for (const pending of this.owners.values())
      if (pending !== record)
        for (const [id, ranges] of (pending.used ? pending : (pending.retained ?? pending)).result) {
          total += ranges.length;
          perParagraph.set(id, (perParagraph.get(id) ?? 0) + ranges.length);
        }
    check(total <= 4096 && [...perParagraph.values()].every((count) => count <= 1024));
    record.result = result;
    this.publish();
  }
  remove(owner: string): void {
    if (this.owners.delete(owner)) this.publish();
  }
  reset(): void {
    this.owners.clear();
    this.publish();
  }
  private publish(): void {
    const next = new Map<string, readonly PluginParagraphLayer[]>();
    const ordered = [...this.owners].sort(
      ([aid, a], [bid, b]) => a.order - b.order || (aid < bid ? -1 : aid > bid ? 1 : 0),
    );
    for (const [, pending] of ordered) {
      const owner = pending.used ? pending : (pending.retained ?? pending);
      for (const [id, ranges] of owner.result) {
        const layers = next.get(id) ?? [];
        next.set(
          id,
          Object.freeze([...layers, Object.freeze({ text: owner.texts.get(id)!, ranges: Object.freeze(ranges) })]),
        );
      }
    }
    const typography = JSON.stringify(
      [...next]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([id, layers]) => [
          id,
          layers
            .map((layer) => [
              layer.text,
              layer.ranges
                .filter((r) => r.style.fontWeight !== undefined || r.style.fontStyle !== undefined)
                .map((r) => [r.start, r.end, r.style.fontWeight, r.style.fontStyle]),
            ])
            .filter(([, ranges]) => (ranges as unknown[]).length),
        ])
        .filter(([, layers]) => (layers as unknown[]).length),
    );
    const layoutChanged =
      typography !== this.layoutFingerprint && !(this.layoutFingerprint === '' && typography === '[]');
    this.layoutFingerprint = typography;
    if (layoutChanged) this.layoutRevision++;
    const changed = new Set<string>();
    for (const id of new Set([...this.snapshots.keys(), ...next.keys()])) {
      const old = this.snapshots.get(id),
        value = next.get(id);
      if (JSON.stringify(old) !== JSON.stringify(value)) changed.add(id);
      else if (old) next.set(id, old);
    }
    this.snapshots = next;
    this.changed(changed);
    if (layoutChanged) for (const listener of this.layoutListeners) listener();
  }
}
