import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import pg from 'pg';
import { expect, it } from 'vitest';
import checksums from './migrations-before-boaa.json';

it('preserves every pre-BOAA migration checksum for existing installations', async () => {
  for (const [name, checksum] of Object.entries(checksums)) {
    const sql = await readFile(new URL(`./migrations/${name}`, import.meta.url));
    expect(createHash('sha256').update(sql).digest('hex'), name).toBe(checksum);
  }
});

it.skipIf(!process.env.BOAA_TEST_POSTGRES_BIN)(
  'upgrades host JSON once while preserving source identities, opaque state and archive bytes',
  async () => {
    const bin = process.env.BOAA_TEST_POSTGRES_BIN!;
    const root = await mkdtemp(path.join(process.env.BOAA_TEST_TMPDIR ?? tmpdir(), 'boaa-pg-'));
    const data = path.join(root, 'data');
    const socket = path.join(root, 'socket');
    await mkdir(socket, { mode: 0o700 });
    const client = new pg.Client({ host: socket, port: 55437, user: 'boaa_test', database: 'postgres' });
    let started = false;
    try {
      execFileSync(
        path.join(bin, 'initdb'),
        ['-D', data, '-U', 'boaa_test', '--no-locale', '--encoding=UTF8', '--auth=trust'],
        { stdio: 'pipe' },
      );
      execFileSync(
        path.join(bin, 'pg_ctl'),
        [
          '-D',
          data,
          '-l',
          path.join(root, 'postgres.log'),
          '-o',
          `-k ${socket} -p 55437 -h '' -c shared_buffers=16MB -c max_connections=5`,
          '-w',
          'start',
        ],
        { stdio: 'pipe' },
      );
      started = true;
      await client.connect();
      await client.query(
        'create table reader_settings(id int, settings jsonb); create table extension_packages(metadata jsonb, source_state jsonb, active_archive bytea); create table extension_repositories(metadata jsonb)',
      );
      await client.query('insert into reader_settings values (1,$1),(2,$2)', [
        {
          _moyaIntegrations: {
            enabledByExtensionId: { 'moya.ai': false },
            source: { connectorId: 'moya.external.dropbox.files' },
          },
          title: 'Moya notes',
          definitionId: 'moya.ai.tts.book-preparation',
        },
        { _moyaIntegrations: { enabled: true }, _boaaIntegrations: { enabled: false } },
      ]);
      const profile = { profiles: { __moya_global_comic_profile__: { id: '__moya_global_comic_profile__' } } };
      await client.query('insert into reader_settings values (3,$1)', [profile]);
      const owned = { 'moya.owned': { id: 'moya.user-data' } };
      const metadata = {
        active: {
          digest: 'unchanged',
          manifest: {
            packageFormat: 'moya.extension.package',
            execution: { kind: 'moya-js' },
            extension: { engine: { moyaApi: 1 } },
          },
          settings: owned,
        },
      };
      await client.query('insert into extension_packages values($1,$2,$3)', [
        metadata,
        owned,
        Buffer.from('original signed archive'),
      ]);
      await client.query('insert into extension_repositories values($1)', [{ format: 'moya.extension.repository' }]);
      const sql = await readFile(new URL('./migrations/0058_boaa_brand_compatibility.sql', import.meta.url), 'utf8');
      await client.query(sql);
      const rows = (await client.query('select settings from reader_settings order by id')).rows;
      expect(rows[0].settings).toEqual({
        _boaaIntegrations: {
          enabledByExtensionId: { 'boaa.ai': false },
          source: { connectorId: 'moya.external.dropbox.files' },
        },
        title: 'Moya notes',
        definitionId: 'moya.ai.tts.book-preparation',
      });
      expect(rows[1].settings).toEqual({ _boaaIntegrations: { enabled: false } });
      expect(rows[2].settings).toEqual(profile);
      const stored = (await client.query('select * from extension_packages')).rows[0];
      expect(stored.metadata.active.manifest).toEqual({
        packageFormat: 'boaa.extension.package',
        execution: { kind: 'boaa-js' },
        extension: { engine: { boaaApi: 1 } },
      });
      expect(stored.metadata.active.settings).toEqual(owned);
      expect(stored.source_state).toEqual(owned);
      expect(stored.active_archive).toEqual(Buffer.from('original signed archive'));
      expect((await client.query('select * from extension_repositories')).rows[0].metadata.format).toBe(
        'boaa.extension.repository',
      );
      await client.query(sql);
      expect((await client.query('select settings from reader_settings order by id')).rows).toEqual(rows);
    } finally {
      await client.end().catch(() => undefined);
      if (started) execFileSync(path.join(bin, 'pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop'], { stdio: 'pipe' });
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
