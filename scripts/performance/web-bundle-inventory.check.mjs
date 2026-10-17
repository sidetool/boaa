import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inventoryWebBundle } from './web-bundle-inventory.mjs';

function fixture(t, manifest) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'boaa-bundle-inventory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.vite'));
  fs.writeFileSync(path.join(root, '.vite/manifest.json'), JSON.stringify(manifest));
  for (const name of ['entry.js', 'shared.js', 'lazy.js', 'main.css', 'lazy.css', 'font.woff2']) {
    fs.writeFileSync(path.join(root, name), name);
  }
  return root;
}

test('counts shared static dependencies once and separates lazy JS/CSS and assets', (t) => {
  const root = fixture(t, {
    'index.html': { file: 'entry.js', isEntry: true, imports: ['shared'], dynamicImports: ['lazy'], css: ['main.css'] },
    shared: { file: 'shared.js', imports: ['index.html'], css: ['main.css'], assets: ['font.woff2'] },
    lazy: { file: 'lazy.js', imports: ['shared'], css: ['lazy.css'] },
    'font.woff2': { file: 'font.woff2', src: 'font.woff2' },
  });
  const result = inventoryWebBundle(root);
  assert.deepEqual(
    result.initial.files.map((item) => item.path),
    ['entry.js', 'main.css', 'shared.js'],
  );
  assert.equal(result.initial.js.raw, 'entry.jsshared.js'.length);
  assert.deepEqual(
    result.deferred.files.map((item) => item.path),
    ['lazy.css', 'lazy.js'],
  );
  assert.deepEqual(
    result.assets.files.map((item) => item.path),
    ['font.woff2'],
  );
});

test('all HTML entries contribute to the initial graph independently of deployment base', (t) => {
  const root = fixture(t, {
    'nested/index.html': { file: 'entry.js', isEntry: true, imports: ['shared'] },
    'admin.html': { file: 'lazy.js', isEntry: true, imports: ['shared'] },
    shared: { file: 'shared.js' },
  });
  assert.equal(inventoryWebBundle(root).initial.js.raw, 'entry.jslazy.jsshared.js'.length);
});

test('fails instead of reporting incomplete or unsafe measurements', (t) => {
  for (const [manifest, pattern] of [
    [{}, /No entry/],
    [{ index: { file: 'entry.js', isEntry: true, imports: ['missing'] } }, /Unknown manifest import/],
    [{ index: { file: '../entry.js', isEntry: true } }, /Invalid manifest asset path/],
    [{ index: { file: 'missing.js', isEntry: true } }, /ENOENT/],
  ]) {
    assert.throws(() => inventoryWebBundle(fixture(t, manifest)), pattern);
  }
  const root = fixture(t, {});
  fs.unlinkSync(path.join(root, '.vite/manifest.json'));
  assert.throws(() => inventoryWebBundle(root), /manifest is missing/);
});
