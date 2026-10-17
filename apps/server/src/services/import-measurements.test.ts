import { expect, test, vi } from 'vitest';
import { createStructuredLogger } from '../observability/logger.js';
import { ImportMeasurements } from './import-measurements.js';

test('reports bounded phase times and byte/page counts through the redacting logger', () => {
  const lines: string[] = [];
  const logger = createStructuredLogger({ service: 'worker', sink: { write: (line) => lines.push(line) } });
  let now = 0;
  const measurements = new ImportMeasurements(logger, 'job_test', () => now);
  now = 10;
  measurements.start('base_read_merge');
  now = 40;
  measurements.start('write_assets');
  measurements.counts.reusedPages = 83;
  measurements.counts.writtenPages = 65;
  now = 60;
  measurements.finish('not_committed');
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!)).toMatchObject({
    event: 'import_job_profile',
    jobId: 'job_test',
    outcome: 'not_committed',
    state: 'write_assets',
    durationMs: 60,
    reusedPages: 83,
    writtenPages: 65,
    phasesMs: { read_upload: 10, base_read_merge: 30, write_assets: 20 },
  });
  expect(() =>
    new ImportMeasurements(
      {
        info() {
          throw new Error('sink');
        },
      },
      'job_test',
    ).finish('noop'),
  ).not.toThrow();
});

test('separates pool wait, content replacement and reader-state restoration from transaction setup', () => {
  const info = vi.fn();
  let now = 0;
  const measurements = new ImportMeasurements({ info }, 'synthetic-job', () => now);
  measurements.start('database_pool');
  now = 800;
  measurements.start('commit_database');
  now = 850;
  measurements.start('write_rows');
  now = 1000;
  measurements.start('restore_reader_state');
  now = 1100;
  measurements.start('finalize_revision');
  now = 1120;
  measurements.finish('committed');
  expect(info).toHaveBeenCalledWith(
    'import_job_profile',
    expect.objectContaining({
      durationMs: 1120,
      phasesMs: {
        read_upload: 0,
        database_pool: 800,
        commit_database: 50,
        write_rows: 150,
        restore_reader_state: 100,
        finalize_revision: 20,
      },
    }),
  );
});

test('keeps the row-write timing numeric through production log redaction', () => {
  const lines: string[] = [];
  const logger = createStructuredLogger({ service: 'worker', sink: { write: (line) => lines.push(line) } });
  let now = 0;
  const measurement = new ImportMeasurements(logger, 'synthetic', () => now);
  measurement.start('write_rows');
  now = 450;
  measurement.finish('committed');
  expect(JSON.parse(lines[0]!).phasesMs.write_rows).toBe(450);
});
