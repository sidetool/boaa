import { ReaderPluginDecorationLayers, type PluginParagraphLayer } from '../../reader/plugin-decoration-layers';
import type { Character, LabeledSegment, ReaderHighlight } from '../../domain/types';
import type { ActiveTTSPlayback } from '../../providers/tts-playback-session';

export interface ReaderDecorationInput {
  readonly segments: readonly LabeledSegment[];
  readonly characters: readonly Character[];
  readonly highlights: readonly ReaderHighlight[];
  readonly reviewSegmentIds: ReadonlySet<string>;
  readonly correctionTargetId?: string;
  readonly activePlayback?: ActiveTTSPlayback;
}

export interface ReaderParagraphDecoration {
  readonly pluginLayers?: readonly PluginParagraphLayer[];
  readonly segments: readonly LabeledSegment[];
  readonly characters: readonly Character[];
  readonly highlights: readonly ReaderHighlight[];
  readonly reviewSegmentIds: ReadonlySet<string>;
  readonly correctionTargetId?: string;
  readonly activeRanges: readonly { start: number; end: number }[];
}

interface StoredDecoration {
  readonly fingerprint: string;
  readonly staticFingerprint: string;
  readonly snapshot: ReaderParagraphDecoration;
}

const EMPTY_IDS = new Set<string>();
const EMPTY_DECORATION: ReaderParagraphDecoration = {
  segments: [],
  characters: [],
  highlights: [],
  reviewSegmentIds: EMPTY_IDS,
  activeRanges: [],
};

function rangesFingerprint(ranges: ReaderParagraphDecoration['activeRanges']): string {
  return ranges.map((range) => `${range.start}:${range.end}`).join('|');
}

function groupedByParagraph<T extends { paragraphId: string }>(items: readonly T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(item.paragraphId);
    if (group) group.push(item);
    else groups.set(item.paragraphId, [item]);
  }
  return groups;
}

function characterFingerprint(characters: readonly Character[]): string {
  return characters
    .map(
      (character) =>
        `${character.id}:${character.canonicalName}:${character.color}:${character.isUserConfirmed ? 1 : 0}`,
    )
    .join('|');
}

function segmentFingerprint(segment: LabeledSegment, needsReview: boolean): string {
  return [
    segment.id,
    segment.type,
    segment.speakerId,
    segment.emotion,
    segment.confidence,
    segment.startOffset,
    segment.endOffset,
    segment.isUserCorrected ? 1 : 0,
    needsReview ? 1 : 0,
  ].join(':');
}

function highlightFingerprint(highlight: ReaderHighlight): string {
  return `${highlight.id}:${highlight.color}:${highlight.quote}:${highlight.updatedAt}`;
}

export class ReaderDecorationStore {
  private readonly listeners = new Map<string, Set<() => void>>();
  private decorations = new Map<string, StoredDecoration>();
  // These inputs are immutable snapshots. Playback updates must not regroup every annotation.
  private staticInput?: Omit<ReaderDecorationInput, 'activePlayback'>;
  private activeParagraphId?: string;
  private emptyStaticFingerprint = '';

  private pluginSnapshots = new Map<
    string,
    { base: ReaderParagraphDecoration; layers: readonly PluginParagraphLayer[]; snapshot: ReaderParagraphDecoration }
  >();
  readonly plugins = new ReaderPluginDecorationLayers((ids) => {
    for (const id of ids) {
      this.pluginSnapshots.delete(id);
      for (const listener of this.listeners.get(id) ?? []) listener();
    }
  });

  subscribe(paragraphId: string, listener: () => void): () => void {
    const listeners = this.listeners.get(paragraphId) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(paragraphId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(paragraphId);
    };
  }

  getSnapshot(paragraphId: string): ReaderParagraphDecoration {
    const base = this.decorations.get(paragraphId)?.snapshot ?? EMPTY_DECORATION;
    const layers = this.plugins.getSnapshot(paragraphId);
    if (!layers.length) return base;
    const previous = this.pluginSnapshots.get(paragraphId);
    if (previous?.base === base && previous.layers === layers) return previous.snapshot;
    const snapshot = { ...base, pluginLayers: layers };
    this.pluginSnapshots.set(paragraphId, { base, layers, snapshot });
    return snapshot;
  }

  update(input: ReaderDecorationInput): void {
    const previousInput = this.staticInput;
    if (
      previousInput &&
      previousInput.segments === input.segments &&
      previousInput.characters === input.characters &&
      previousInput.highlights === input.highlights &&
      previousInput.reviewSegmentIds === input.reviewSegmentIds &&
      previousInput.correctionTargetId === input.correctionTargetId
    ) {
      this.updatePlayback(input);
      return;
    }
    this.staticInput = {
      segments: input.segments,
      characters: input.characters,
      highlights: input.highlights,
      reviewSegmentIds: input.reviewSegmentIds,
      correctionTargetId: input.correctionTargetId,
    };
    this.activeParagraphId = input.activePlayback?.paragraphId;
    const segments = groupedByParagraph(input.segments);
    const highlights = groupedByParagraph(input.highlights);
    const paragraphIds = new Set([...this.decorations.keys(), ...segments.keys(), ...highlights.keys()]);
    if (input.activePlayback?.paragraphId) paragraphIds.add(input.activePlayback.paragraphId);

    const next = new Map<string, StoredDecoration>();
    const charactersKey = characterFingerprint(input.characters);
    this.emptyStaticFingerprint = `${charactersKey}::::::`;
    for (const paragraphId of paragraphIds) {
      const paragraphSegments = segments.get(paragraphId) ?? [];
      const paragraphHighlights = highlights.get(paragraphId) ?? [];
      const reviewIds = new Set(
        paragraphSegments.filter((segment) => input.reviewSegmentIds.has(segment.id)).map((segment) => segment.id),
      );
      const correctionTargetId = paragraphSegments.some((segment) => segment.id === input.correctionTargetId)
        ? input.correctionTargetId
        : undefined;
      const activeRanges = input.activePlayback?.paragraphId === paragraphId ? input.activePlayback.ranges : [];
      const staticFingerprint = [
        charactersKey,
        paragraphSegments.map((segment) => segmentFingerprint(segment, reviewIds.has(segment.id))).join('|'),
        paragraphHighlights.map(highlightFingerprint).join('|'),
        correctionTargetId ?? '',
      ].join('::');
      const fingerprint = `${staticFingerprint}::${rangesFingerprint(activeRanges)}`;
      const previous = this.decorations.get(paragraphId);
      if (previous?.fingerprint === fingerprint) {
        next.set(paragraphId, previous);
        continue;
      }
      if (paragraphSegments.length === 0 && paragraphHighlights.length === 0 && activeRanges.length === 0) continue;
      next.set(paragraphId, {
        fingerprint,
        staticFingerprint,
        snapshot: {
          segments: paragraphSegments,
          characters: input.characters,
          highlights: paragraphHighlights,
          reviewSegmentIds: reviewIds,
          correctionTargetId,
          activeRanges,
        },
      });
    }

    const changed = new Set<string>();
    for (const paragraphId of new Set([...this.decorations.keys(), ...next.keys()])) {
      if (this.decorations.get(paragraphId)?.snapshot !== next.get(paragraphId)?.snapshot) changed.add(paragraphId);
    }
    this.decorations = next;
    for (const paragraphId of changed) {
      this.pluginSnapshots.delete(paragraphId);
      for (const listener of this.listeners.get(paragraphId) ?? []) listener();
    }
  }

  private updatePlayback(input: ReaderDecorationInput): void {
    const active = input.activePlayback;
    const ids = new Set([this.activeParagraphId, active?.paragraphId]);
    this.activeParagraphId = active?.paragraphId;
    const changed: string[] = [];
    for (const id of ids) {
      if (!id) continue;
      const previous = this.decorations.get(id);
      const base = previous?.snapshot ?? { ...EMPTY_DECORATION, characters: input.characters };
      const ranges = active?.paragraphId === id ? active.ranges : [];
      if (rangesFingerprint(base.activeRanges) === rangesFingerprint(ranges)) continue;
      if (!base.segments.length && !base.highlights.length && !ranges.length) {
        this.decorations.delete(id);
      } else {
        const staticFingerprint = previous?.staticFingerprint ?? this.emptyStaticFingerprint;
        this.decorations.set(id, {
          staticFingerprint,
          fingerprint: `${staticFingerprint}::${rangesFingerprint(ranges)}`,
          snapshot: { ...base, activeRanges: ranges },
        });
      }
      this.pluginSnapshots.delete(id);
      changed.push(id);
    }
    // Publish only after both the old and current paragraph snapshots are updated.
    for (const id of changed) for (const listener of this.listeners.get(id) ?? []) listener();
  }
}
