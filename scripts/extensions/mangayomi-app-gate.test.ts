import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { prepareMangayomiAppGate } from './mangayomi-app-gate';

it('serves synthetic app search, preferences, details and image bytes entirely offline', async () => {
  const output = await mkdtemp(join(tmpdir(), 'boaa-offline-app-'));
  const fixture = await prepareMangayomiAppGate('', output);
  const signal = AbortSignal.timeout(10000);
  try {
    fixture.setImage(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOm0AAAAASUVORK5CYII=',
        'base64',
      ),
    );
    const plan = await fixture.host.inspectFile(await readFile(fixture.file), 'synthetic-images.js', 1, signal);
    await fixture.host.install(plan.id, plan.revision, signal);
    const id = fixture.host.catalog.getSources()[0].descriptor.id;
    const pkg = fixture.host.snapshot().packages[0].pkg;
    await fixture.host.savePreferences(
      pkg,
      fixture.host.preferences(pkg).revision,
      { original_languages: ['originalLanguage[]=ko', 'originalLanguage[]=ja'] },
      [],
    );
    const missing = await fixture.host.catalog.invoke(id, 'source.listWorks', { query: 'missing' }, signal);
    expect(missing.result.items).toEqual([]);
    const works = await fixture.host.catalog.invoke(id, 'source.listWorks', { query: 'Fixture' }, signal);
    expect(works.result.items[0].title).toBe('Synthetic image work');
    const query = new URL(fixture.calls.at(-1)!);
    expect(query.searchParams.getAll('originalLanguage[]')).toEqual(['ko', 'ja']);
    const workId = works.result.items[0].id;
    const detail = await fixture.host.catalog.invoke(id, 'source.getWork', { workId }, signal);
    expect(detail.result.title).toBe('Synthetic image work');
    const releases = await fixture.host.catalog.invoke(id, 'source.listReleases', { workId }, signal);
    expect(releases.result.items[0].title).toBe('Ch.1 Fixture chapter');
    const content = await fixture.host.catalog.invoke(
      id,
      'source.getContent',
      { workId, releaseId: releases.result.items[0].id },
      signal,
    );
    expect(content.result.kind).toBe('images');
    expect([...content.assets.values()][0].type).toBe('image/png');
    expect(fixture.calls.every((url) => new URL(url).hostname.endsWith('.example'))).toBe(true);
  } finally {
    fixture.host.close();
    await rm(output, { recursive: true, force: true });
  }
});
