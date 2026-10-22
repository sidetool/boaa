import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { checkWebNotices } from './check-web-notices.mjs';

async function fixture(t, components, records = []) {
  const root = await mkdtemp(path.join(tmpdir(), 'boaa-web-notices-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dist = path.join(root, 'dist');
  const npmNotices = path.join(root, 'notices');
  async function write(name, value) {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));
  }
  await write('dist/licenses/web-123-inventory.json', { components });
  await write('third_party/server-component-evidence.json', { components: records });
  return { root, dist, npmNotices, write };
}

test('a vendored license outside the component mapping fails; its served mapping fixes the failure', async (t) => {
  const f = await fixture(t, [{ name: 'page-flip', version: '2.0.7', license: 'MIT' }]);
  await f.write('dist/third_party/licenses/st-page-flip/LICENSE', 'original MIT notice');
  await assert.rejects(checkWebNotices(f), /web_component_notice_missing: page-flip@2.0.7/);
  await f.write('dist/licenses/npm/page-flip%402.0.7/LICENSE', 'original MIT notice');
  assert.equal(await checkWebNotices(f), 1);
});

test('worker inventory is also checked and an unrelated package notice cannot satisfy it', async (t) => {
  const f = await fixture(t, [{ name: 'example', version: '1.0.0', license: 'MIT' }]);
  await f.write('notices/example%401.0.0/LICENSE', 'MIT');
  await f.write('dist/assets/licenses/web-456-inventory.json', {
    components: [{ name: 'worker-only', version: '2', license: 'MIT' }],
  });
  await assert.rejects(checkWebNotices(f), /worker-only@2/);
});

test('supplemental notice must match its recorded hash', async (t) => {
  const notice = 'upstream notice';
  const f = await fixture(
    t,
    [{ name: 'example', version: '1' }],
    [
      {
        ecosystem: 'npm',
        name: 'example',
        version: '1',
        licenses: ['MIT'],
        notices: [{ sha256: createHash('sha256').update(notice).digest('hex') }],
      },
    ],
  );
  await f.write('third_party/licenses/common/notice.txt', notice);
  assert.equal(await checkWebNotices(f), 1);
  await f.write('third_party/licenses/common/notice.txt', 'changed');
  await assert.rejects(checkWebNotices(f), /web_component_notice_missing/);
});

test('absent inventory does not silently pass', async (t) => {
  const f = await fixture(t, []);
  await rm(path.join(f.dist, 'licenses'), { recursive: true });
  await assert.rejects(checkWebNotices(f), /web_component_inventory_missing/);
});
