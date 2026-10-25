import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

function filesIn(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? filesIn(file) : [file];
  });
}

test('script UI imports resolve, including imports inside browser fixture strings', () => {
  const missing = [];
  for (const file of filesIn(path.join(root, 'scripts'))) {
    if (!/\.(?:mjs|cjs|js|ts|tsx)$/.test(file) || /\.(?:test|spec)\./.test(file)) continue;
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\b(?:from\s*|import\s*\(\s*|import\s*)(['"])([^'"\n]+)\1/g)) {
      const specifier = match[2];
      if (!/(?:^|\/)src\/(?:ui-next|features|shared|components)\//.test(specifier)) continue;
      // Browser fixtures use Vite's /src root, ./src from a virtual root entry,
      // or a template interpolation naming the repository root.
      const resolved = specifier.replace(/^\$\{[^}]+\}(?=\/src\/)/, root.replace(/\/$/, ''));
      if (resolved.includes('${')) continue;
      const modulePath = resolved.replace(/[?#].*$/, '');
      const candidate = /^(?:\.\/|\/)src\//.test(modulePath)
        ? path.join(root, modulePath.replace(/^\.?\//, ''))
        : path.resolve(path.dirname(file), modulePath);
      const extensions = ['', '.ts', '.tsx', '.mts', '.js', '.mjs', '.json', '.css', '/index.ts', '/index.tsx'];
      if (!extensions.some((extension) => existsSync(candidate + extension))) {
        const line = source.slice(0, match.index).split('\n').length;
        missing.push(`${path.relative(root, file)}:${line}: ${specifier}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

test('workflow package commands and repository file entrypoints exist', () => {
  const packagePath = path.join(root, 'package.json');
  const scripts = JSON.parse(readFileSync(packagePath, 'utf8')).scripts;
  const workflows = filesIn(path.join(root, '.github/workflows')).filter((file) => /\.ya?ml$/.test(file));
  const missing = [];
  for (const file of [packagePath, ...workflows]) {
    const source = readFileSync(file, 'utf8');
    if (file !== packagePath) {
      for (const [, command] of source.matchAll(/\bpnpm\s+(?:run\s+)?([\w-]+:[\w:-]+)/g)) {
        if (!Object.hasOwn(scripts, command)) missing.push(`${path.relative(root, file)}: ${command}`);
      }
    }
    for (const [, entrypoint] of source.matchAll(
      /(?<![\w./-])((?:scripts|src)\/[\w./-]+\.(?:mjs|cjs|js|tsx?|json))\b/g,
    )) {
      if (!existsSync(path.join(root, entrypoint))) missing.push(`${path.relative(root, file)}: ${entrypoint}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('Quality phases preserve the discovered union and isolate runtime files without changing deadlines', async () => {
  const { qualityTestPhases } = await import('./quality-tests.mjs');
  const host = path.join(root, 'apps/server/src/extensions/mangayomi/host.test.ts');
  const contract = path.join(root, 'apps/server/src/extensions/mangayomi/http-contract.test.ts');
  const ordinary = path.join(root, 'src/test/parser.test.ts');
  const files = [ordinary, host, contract, host];
  const phases = qualityTestPhases(files, root);
  assert.deepEqual(phases, [
    { files: [host], maxWorkers: 1 },
    { files: [contract], maxWorkers: 1 },
    { files: [ordinary], maxWorkers: 2 },
  ]);
  assert.deepEqual(phases.flatMap((phase) => phase.files).sort(), [...new Set(files)].sort());
});

test('Quality discovers once, runs every phase after failures and propagates a failed exit', async () => {
  const { runQualityTests } = await import('./quality-tests.mjs');
  const files = [
    path.join(root, 'apps/server/src/extensions/mangayomi/host.test.ts'),
    path.join(root, 'src/test/parser.test.ts'),
  ];
  for (const failure of [undefined, 1, 2]) {
    const calls = [];
    const status = runQualityTests({
      log: () => {},
      spawn: (_executable, args) => {
        calls.push(args);
        return {
          status: calls.length - 1 === failure ? 1 : 0,
          stdout: JSON.stringify(files.map((file) => ({ file }))),
        };
      },
    });
    assert.equal(status, failure === undefined ? 0 : 1);
    assert.equal(calls.length, 3);
    assert.equal(calls.filter((args) => args[1] === 'list').length, 1);
    // --json takes an optional path; no following filter may be consumed as its output file.
    assert.equal(calls[0].at(-1), '--json');
    assert.deepEqual(
      calls
        .slice(1)
        .flatMap((args) => args.slice(2, -1))
        .sort(),
      files.sort(),
    );
    assert.ok(calls.every((args) => !args.some((arg) => /timeout|exclude|retry/i.test(arg))));
  }
});

test('Quality list mode retains its output and discovery failure never starts partial suites', async () => {
  const { runQualityTests } = await import('./quality-tests.mjs');
  const calls = [];
  const spawn = (_executable, args, options) => {
    calls.push({ args, options });
    return { status: 7, stdout: 'not a file list' };
  };
  assert.equal(runQualityTests({ listOnly: true, spawn }), 7);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.stdio, 'inherit');
  assert.deepEqual(calls[0].args.slice(1, 3), ['list', '--filesOnly']);
  calls.length = 0;
  assert.equal(runQualityTests({ spawn }), 7);
  assert.equal(calls.length, 1);
});
