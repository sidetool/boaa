import { describe, expect, it } from 'vitest';
import { parseTTSFilterFile, spokenFilterMatches, validateSpokenTextFilter } from './spoken-text-filter';
import { projectSpokenText } from './spoken-text';
import type { SpokenTextRule } from '@boaa/contracts';
const rule = (
  pattern: string,
  replacement: string,
  kind: 'replace_literal' | 'replace_regex' = 'replace_regex',
): SpokenTextRule & { kind: 'replace_literal' | 'replace_regex' } => ({
  id: 'test',
  scope: 'book',
  bookId: 'book',
  kind,
  pattern,
  replacement,
  enabled: true,
  priority: 0,
  updatedAt: '',
});
const project = (text: string, rules: SpokenTextRule[]) => projectSpokenText({ text, rules, language: 'und' });
describe('spoken text filters', () => {
  it('preserves whitespace and empty replacements in the imported format and reports invalid lines', () => {
    const parsed = parseTTSFilterFile('\uFEFF a #-># b \r\n[!?]#->#\ninvalid\n(#->#\nx(?!y)#->#z\n');
    expect(parsed.rules.map(({ pattern, replacement }) => [pattern, replacement])).toEqual([
      [' a ', ' b '],
      ['[!?]', ''],
    ]);
    expect(parsed.errors.map((e) => e.line)).toEqual([3, 4, 5]);
  });
  it('supports captures, optional groups, literal dollars, and sequential replacement', () => {
    expect(project('ab a', [rule('(a)(b)?', '$2$1$$'), rule('ba', '읽기', 'replace_literal')]).spokenText).toBe(
      '읽기$ a$',
    );
  });
  it('does not treat a literal as regex or expand its replacement tokens', () => {
    expect(project('a.b axb', [rule('a.b', '$1', 'replace_literal')]).spokenText).toBe('$1 axb');
  });
  it('retains source offsets after emoji, deletion, and zero-width insertion', () => {
    const result = project('😀ab cd', [rule('ab', '말'), rule('cd', '')]);
    expect(result.spokenText).toBe('😀말');
    expect(result.spans.find((s) => s.transform === 'pronunciation')).toMatchObject({ sourceStart: 2, sourceEnd: 4 });
    expect(project('ab', [rule('^', '앞 ')]).spokenText).toBe('앞 ab');
    expect(project('aa', [rule('a', 'aa')]).spokenText).toBe('aaaa');
  });
  it('handles nested repetition with a linear matcher and rejects unsupported patterns', () => {
    expect([
      ...spokenFilterMatches('a'.repeat(20000) + '!', { kind: 'replace_regex', pattern: '(a+)+$', replacement: '' }),
    ]).toEqual([]);
    expect(validateSpokenTextFilter(rule('(a)\\1', ''))).toBeTruthy();
    expect(validateSpokenTextFilter(rule('(', ''))).toBeTruthy();
  });
  it('bounds import and expansion without silently truncating speech', () => {
    expect(parseTTSFilterFile('x#->#y\n'.repeat(101)).errors).toHaveLength(1);
    expect(parseTTSFilterFile('x'.repeat(65537)).rules).toEqual([]);
    expect(() => project('x'.repeat(1000), [rule('x', 'y'.repeat(256))])).toThrow('너무 길어요');
  });
});
