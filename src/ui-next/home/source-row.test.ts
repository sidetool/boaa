import { describe, expect, it } from 'vitest';
import { normalizeHomeRows, normalizeHomeSourceSection, MAX_HOME_ROWS } from '@boaa/reader-core/settings';
import { validateSettingsBody } from '../../../apps/server/src/routes/books/request-contracts';
import type { ExternalSourceFilterDefinition } from '../../external-sources/contracts';
import { normalizeSourceRowSection, sourceRowInput, sourceRowSummary } from './source-row';
const section = { sourceId: 'fixture.source', mode: 'popular' as const, title: 'Selected works' };
const row = { id: 'one', kind: 'source', visible: true, section };
const definitions: ExternalSourceFilterDefinition[] = [
  { id: 'day', position: 0, kind: 'select', label: 'Day', options: ['All', '월요일'], defaultValue: 0 },
  {
    id: 'genre',
    position: 0,
    groupPosition: 1,
    kind: 'select',
    label: 'Genre',
    options: ['All', '무협'],
    defaultValue: 0,
  },
  { id: 'heading', position: 4, kind: 'header', label: 'Heading' },
];
const filters = [
  { position: 0, value: 1 },
  { position: 0, groupPosition: 1, value: 1 },
];

describe('independent source row wire contract', () => {
  it('retains multiple rows for one source and only portable fields', () => {
    const rows = [
      row,
      {
        ...row,
        id: 'two',
        section: { ...section, filters, summary: 'Summary', query: 'transient', thumbnailUrl: 'blob:transient' },
      },
    ];
    expect(normalizeHomeRows(rows)).toEqual([
      row,
      { ...row, id: 'two', section: { ...section, filters, summary: 'Summary' } },
    ]);
    expect(normalizeHomeRows([...rows, row])).toHaveLength(2);
    expect(normalizeHomeRows([{ ...row, section: undefined }])).toEqual([]);
    expect(validateSettingsBody({ homeRows: rows }).ok).toBe(true);
  });
  it.each([
    { mode: 'search' },
    { sourceId: '' },
    { sourceId: ' '.repeat(2) },
    { sourceId: 's'.repeat(1025) },
    { title: 't'.repeat(1025) },
    { summary: 's'.repeat(1025) },
    { parentRef: 'p'.repeat(4097) },
    { filterSignature: 's'.repeat(65537) },
    { filters: Array.from({ length: 257 }, () => ({ position: 0, value: true })) },
    { filters: [{ position: -1, value: true }] },
    { filters: [{ position: 0, value: { index: -2, ascending: true } }] },
  ])('rejects invalid section limits without saving a partially dropped row: %j', (patch) => {
    const invalid = { ...section, ...patch };
    expect(normalizeHomeSourceSection(invalid)).toBeUndefined();
    expect(validateSettingsBody({ homeRows: [{ ...row, section: invalid }] }).ok).toBe(false);
  });
  it('bounds row count and the total serialized payload', () => {
    const many = Array.from({ length: MAX_HOME_ROWS + 1 }, (_, index) => ({ ...row, id: String(index) }));
    expect(normalizeHomeRows(many)).toHaveLength(MAX_HOME_ROWS);
    expect(validateSettingsBody({ homeRows: many }).ok).toBe(false);
    const large = Array.from({ length: 9 }, (_, index) => ({
      ...row,
      id: String(index),
      section: { ...section, filterSignature: 'a'.repeat(65536) },
    }));
    expect(normalizeHomeRows(large)).toBeUndefined();
    expect(validateSettingsBody({ homeRows: large }).ok).toBe(false);
  });
  it('builds search requests for filters, without a query, and summarizes grouped definitions', () => {
    expect(sourceRowInput({ ...section, filters })).toEqual({ browseMode: 'search', filters, parentRef: undefined });
    expect(sourceRowInput({ ...section, mode: 'latest', filters: [] }).browseMode).toBe('latest');
    expect(sourceRowInput(section)).not.toHaveProperty('query');
    expect(sourceRowSummary({ ...section, filters }, definitions)).toBe('인기 · 월요일 · 무협');
    expect(sourceRowSummary({ ...section, mode: 'latest', filters: [{ position: 0, value: 0 }] }, definitions)).toBe(
      '최신',
    );
    expect(sourceRowSummary({ ...section, filters: [{ position: 0, value: 999 }] }, definitions)).toBe('인기');
  });
  it('computes a schema signature when definitions are supplied, without requiring one for a valid row', () => {
    expect(normalizeSourceRowSection({ ...section, filters }, definitions)).toEqual({
      ...section,
      filters,
      filterSignature: JSON.stringify(definitions),
    });
    expect(normalizeSourceRowSection({ ...section, filters })).toEqual({ ...section, filters });
  });
});
