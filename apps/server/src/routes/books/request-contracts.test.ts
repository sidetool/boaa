import { describe, expect, it } from 'vitest';
import { defaultSettings } from '@boaa/reader-core/settings';
import { validateSettingsBody } from './request-contracts';

describe('reader settings request contract', () => {
  it.each(['server-voice-a', ''])('round-trips the global narration settings with server voice %j', (serverVoiceId) => {
    const playback = {
      ...defaultSettings.ttsPlayback,
      mode: 'plain',
      voiceSource: 'server',
      serverVoiceId,
      offlineOnly: true,
      footnotePlayback: 'immediate',
    };
    const saved = validateSettingsBody({ ...defaultSettings, ttsPlayback: playback });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.value.ttsPlayback).toEqual(playback);

    const restored = validateSettingsBody(JSON.parse(JSON.stringify(saved.value)));
    expect(restored).toEqual(saved);
  });

  it('round-trips sparse book narration overrides including an explicit default voice', () => {
    const overrides = {
      cast_book: {
        mode: 'cast',
        voiceSource: 'system',
        serverVoiceId: 'book-voice',
        offlineOnly: true,
        footnotePlayback: 'skip',
      },
      default_voice_book: { mode: 'plain', voiceSource: 'server', serverVoiceId: '' },
      inherit_voice_book: { mode: 'plain' },
    };
    const saved = validateSettingsBody({
      ...defaultSettings,
      ttsPlayback: {
        ...defaultSettings.ttsPlayback,
        mode: 'plain',
        voiceSource: 'server',
        serverVoiceId: 'global-voice',
      },
      ttsBookOverrides: overrides,
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.value.ttsBookOverrides).toEqual(overrides);
    expect(saved.value.ttsBookOverrides?.default_voice_book?.serverVoiceId).toBe('');
    expect(saved.value.ttsBookOverrides?.inherit_voice_book).not.toHaveProperty('serverVoiceId');

    const restored = validateSettingsBody(JSON.parse(JSON.stringify(saved.value)));
    expect(restored).toEqual(saved);
  });

  describe.each(['global', 'book'])('%s narration validation', (scope) => {
    it.each([
      { field: 'mode', value: 'automatic', error: 'ttsPlayback.mode is invalid' },
      { field: 'voiceSource', value: 'cloud', error: 'ttsPlayback.voiceSource is invalid' },
      { field: 'serverVoiceId', value: 42, error: 'ttsPlayback.serverVoiceId is invalid' },
      { field: 'serverVoiceId', value: 'v'.repeat(161), error: 'ttsPlayback.serverVoiceId is invalid' },
      { field: 'offlineOnly', value: 'true', error: 'ttsPlayback.offlineOnly must be boolean' },
      { field: 'footnotePlayback', value: 'unknown', error: 'ttsPlayback.footnotePlayback is invalid' },
    ])('rejects an invalid $field', ({ field, value, error }) => {
      const patch = { [field]: value };
      const body =
        scope === 'global'
          ? { ...defaultSettings, ttsPlayback: { ...defaultSettings.ttsPlayback, ...patch } }
          : { ...defaultSettings, ttsBookOverrides: { book_1: patch } };
      expect(validateSettingsBody(body)).toEqual({ ok: false, error });
    });
  });

  it('preserves a custom application palette independently from the Reader theme', () => {
    const result = validateSettingsBody({
      ...defaultSettings,
      applicationTheme: 'custom',
      applicationThemeColors: {
        background: '#101820',
        surface: '#18242d',
        text: '#e8eef2',
        accent: '#54b7a5',
      },
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        value: expect.objectContaining({
          applicationTheme: 'custom',
          applicationThemeColors: {
            background: '#101820',
            surface: '#18242d',
            text: '#e8eef2',
            accent: '#54b7a5',
          },
        }),
      }),
    );
  });

  it('rejects invalid application colors', () => {
    expect(
      validateSettingsBody({
        ...defaultSettings,
        applicationTheme: 'custom',
        applicationThemeColors: { background: 'black' },
      }),
    ).toEqual({ ok: false, error: 'applicationThemeColors.background must be a hex color' });
  });

  it('preserves versioned global and per-book AI workflow preferences', () => {
    const result = validateSettingsBody({
      ...defaultSettings,
      aiWorkflows: {
        schemaVersion: 1,
        defaultWorkflowId: 'moya.ai.analysis.character-bundle',
        bookOverrides: { book_1: 'example.ai.alternate-workflow' },
      },
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        value: expect.objectContaining({
          aiWorkflows: {
            schemaVersion: 1,
            defaultWorkflowId: 'moya.ai.analysis.character-bundle',
            bookOverrides: { book_1: 'example.ai.alternate-workflow' },
          },
        }),
      }),
    );
  });

  it('rejects malformed AI workflow preferences', () => {
    expect(
      validateSettingsBody({
        ...defaultSettings,
        aiWorkflows: {
          schemaVersion: 1,
          defaultWorkflowId: 'not-namespaced',
        },
      }),
    ).toEqual({ ok: false, error: 'aiWorkflows.defaultWorkflowId is invalid' });
  });
});
