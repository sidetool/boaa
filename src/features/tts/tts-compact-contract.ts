import type { TTSSleepTimerPreset } from '../../domain/types';

export interface TTSCompactBarProps {
  readonly bookTitle: string;
  readonly chapterTitle: string;
  readonly speakerLabel?: string;
  readonly playing: boolean;
  readonly paused: boolean;
  readonly busy: boolean;
  readonly rate: number;
  readonly timerPreset?: TTSSleepTimerPreset;
  readonly timerRemainingSeconds?: number;
  readonly status?: string;
  previous(): void;
  next(): void;
  start(): void | Promise<unknown>;
  pause(): void;
  resume(): void;
  stop(): void;
  openSettings(): void;
  setTimer(preset?: TTSSleepTimerPreset): void;
}
