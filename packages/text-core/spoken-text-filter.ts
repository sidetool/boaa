import { RE2JS } from 're2js';

export type SpokenTextFilterInput = {
  kind: 'replace_literal' | 'replace_regex';
  pattern: string;
  replacement?: string;
};
const compiled = new Map<string, RE2JS>();
function regex(pattern: string): RE2JS {
  let result = compiled.get(pattern);
  if (!result) {
    result = RE2JS.compile(pattern);
    if (compiled.size >= 128) compiled.delete(compiled.keys().next().value!);
    compiled.set(pattern, result);
  }
  return result;
}

export function validateSpokenTextFilter(input: SpokenTextFilterInput): string | undefined {
  if (!input.pattern || input.pattern.length > 256) return '찾을 말은 1~256자로 입력해 주세요.';
  if ((input.replacement?.length ?? 0) > 256) return '읽을 말은 256자까지 입력할 수 있어요.';
  if (input.kind !== 'replace_literal' && input.kind !== 'replace_regex') return '교체 방식을 확인해 주세요.';
  if (input.kind === 'replace_regex') {
    try {
      regex(input.pattern);
    } catch {
      return '정규식이 올바르지 않거나 지원하지 않는 표현이에요. 전방 탐색과 패턴 안의 역참조는 지원하지 않아요.';
    }
  }
}

export function parseTTSFilterFile(text: string): {
  rules: Array<SpokenTextFilterInput & { kind: 'replace_regex'; replacement: string }>;
  errors: Array<{ line: number; message: string }>;
} {
  const rules: Array<SpokenTextFilterInput & { kind: 'replace_regex'; replacement: string }> = [];
  const errors: Array<{ line: number; message: string }> = [];
  if (new TextEncoder().encode(text).length > 65536)
    return { rules, errors: [{ line: 0, message: '필터 파일은 64KiB까지 가져올 수 있어요.' }] };
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) continue;
    const separator = line.indexOf('#->#');
    const rule = {
      kind: 'replace_regex' as const,
      pattern: line.slice(0, separator),
      replacement: line.slice(separator + 4),
    };
    const message = separator < 0 ? '정규식#->#읽을 말 형식이 아니에요.' : validateSpokenTextFilter(rule);
    if (message) errors.push({ line: index + 1, message });
    else if (rules.length >= 100) errors.push({ line: index + 1, message: '규칙은 최대 100개까지 가져올 수 있어요.' });
    else rules.push(rule);
  }
  return { rules, errors };
}

/** Matches are evaluated against the original input of this rule, never its own output. */
export function* spokenFilterMatches(text: string, rule: SpokenTextFilterInput) {
  const error = validateSpokenTextFilter(rule);
  if (error) throw new Error(error);
  if (text.length > 100000) throw new Error('필터를 적용할 문단이 너무 길어요. 문단을 나눠 주세요.');
  if (rule.kind === 'replace_literal') {
    let at = 0;
    while ((at = text.indexOf(rule.pattern, at)) >= 0) {
      yield { start: at, end: at + rule.pattern.length, replacement: rule.replacement ?? '' };
      at += rule.pattern.length;
    }
    return;
  }
  for (const match of regex(rule.pattern).matchAll(text)) {
    const replacement = (rule.replacement ?? '').replace(/\$(\$|&|[1-9][0-9]?)/g, (token, group: string) => {
      if (group === '$') return '$';
      if (group === '&') return match[0];
      const index = Number(group);
      if (index < match.length) return match[index] ?? '';
      if (group.length === 2 && Number(group[0]) < match.length) return (match[Number(group[0])] ?? '') + group[1];
      return token;
    });
    yield { start: match.index!, end: match.index! + match[0].length, replacement };
  }
}
