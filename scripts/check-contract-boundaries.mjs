import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const workspaceRoot = path.resolve(import.meta.dirname, '..');
const contractsRoot = path.join(workspaceRoot, 'packages/contracts');
const extensionContractsRoot = path.join(workspaceRoot, 'packages/extension-contracts');
const textCoreRoot = path.join(workspaceRoot, 'packages/text-core');
const readerCoreRoot = path.join(workspaceRoot, 'packages/reader-core');
const readerCorePublicSubpaths = new Set(
  [
    'settings',
    'defaults',
    'settings-scope',
    'search-policy',
    'query-contract',
    'discovery-settings',
    'sync-contract',
  ].map((name) => `@boaa/reader-core/${name}`),
);
const serverRoot = path.join(workspaceRoot, 'apps/server/src');
const sourcePattern = /\.tsx?$/;
const testPattern = /(?:^|[\\/])(?:test|tests)(?:[\\/]|$)|\.(?:test|spec)\.tsx?$/;
const textCorePublicSubpaths = new Set([
  '@boaa/text-core/hash',
  '@boaa/text-core/legacy-hash',
  '@boaa/text-core/normalization',
  '@boaa/text-core/chapter-structure',
  '@boaa/text-core/speaker-attribution',
  '@boaa/text-core/library-metadata',
  '@boaa/text-core/image-format',
  '@boaa/text-core/parser',
  '@boaa/text-core/identity/parser',
  '@boaa/text-core/identity/reader',
  '@boaa/text-core/identity/ai',
  '@boaa/text-core/identity/provider',
  '@boaa/text-core/identity/sync',
  '@boaa/text-core/identity/tts',
  '@boaa/text-core/identity/workflow',
]);
const rootTextRuntimePattern =
  /(?:^|\/)src\/domain\/(?:canonical-json|hash|id-hash-contract|parser(?:\/|$)|identity(?:\/|$))(?:\.js)?$/;

function collectFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectFiles(absolute);
    return entry.isFile() && sourcePattern.test(entry.name) && !testPattern.test(absolute) ? [absolute] : [];
  });
}

function moduleReferences(file) {
  const source = fs.readFileSync(file, 'utf8');
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  return parsed.statements.flatMap((statement) => {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      return [
        {
          specifier: statement.moduleSpecifier.text,
          typeOnly: ts.isImportDeclaration(statement)
            ? Boolean(statement.importClause?.isTypeOnly)
            : Boolean(statement.isTypeOnly),
        },
      ];
    }
    return [];
  });
}

const failures = [];
for (const file of collectFiles(readerCoreRoot)) {
  for (const { specifier, typeOnly } of moduleReferences(file)) {
    const local =
      specifier.startsWith('.') &&
      !path.relative(readerCoreRoot, path.resolve(path.dirname(file), specifier)).startsWith('..');
    if (
      !local &&
      !(
        ['@boaa/contracts', '@boaa/contracts/sync', '@boaa/extension-contracts/source-browse'].includes(specifier) &&
        typeOnly
      )
    ) {
      failures.push(`${path.relative(workspaceRoot, file)} violates reader-core isolation: ${specifier}`);
    }
  }
}
const readerCorePackage = JSON.parse(fs.readFileSync(path.join(readerCoreRoot, 'package.json'), 'utf8'));
for (const specifier of readerCorePublicSubpaths) {
  const exportName = `./${specifier.slice('@boaa/reader-core/'.length)}`;
  if (!Object.hasOwn(readerCorePackage.exports ?? {}, exportName)) {
    failures.push(`reader-core package does not expose public subpath ${exportName}`);
  }
}
for (const file of collectFiles(contractsRoot)) {
  for (const { specifier } of moduleReferences(file)) {
    if (!specifier.startsWith('.')) {
      failures.push(`${path.relative(workspaceRoot, file)} imports external module ${specifier}`);
      continue;
    }
    const target = path.resolve(path.dirname(file), specifier);
    if (path.relative(contractsRoot, target).startsWith('..')) {
      failures.push(`${path.relative(workspaceRoot, file)} imports outside contracts: ${specifier}`);
    }
  }
}

for (const file of collectFiles(extensionContractsRoot)) {
  for (const { specifier } of moduleReferences(file)) {
    if (!specifier.startsWith('.')) {
      failures.push(`${path.relative(workspaceRoot, file)} imports external module ${specifier}`);
      continue;
    }
    const target = path.resolve(path.dirname(file), specifier);
    if (path.relative(extensionContractsRoot, target).startsWith('..')) {
      failures.push(`${path.relative(workspaceRoot, file)} imports outside extension-contracts: ${specifier}`);
    }
  }
}

for (const file of collectFiles(textCoreRoot)) {
  for (const { specifier, typeOnly } of moduleReferences(file)) {
    if (specifier.startsWith('.')) {
      const target = path.resolve(path.dirname(file), specifier);
      if (path.relative(textCoreRoot, target).startsWith('..')) {
        failures.push(`${path.relative(workspaceRoot, file)} imports outside text-core: ${specifier}`);
      }
      continue;
    }
    if (specifier === '@boaa/contracts') {
      if (!typeOnly) {
        failures.push(`${path.relative(workspaceRoot, file)} must use import type for ${specifier}`);
      }
      continue;
    }
    if (
      !specifier.startsWith('@noble/hashes/') &&
      !['#korean-decoder', '@kayahr/text-encoding/no-encodings', '@kayahr/text-encoding/encodings/euc-kr'].includes(
        specifier,
      )
    ) {
      failures.push(`${path.relative(workspaceRoot, file)} imports unsupported runtime module ${specifier}`);
    }
  }
}

const textCorePackage = JSON.parse(fs.readFileSync(path.join(textCoreRoot, 'package.json'), 'utf8'));
const textCoreExports = new Set(Object.keys(textCorePackage.exports ?? {}));
for (const specifier of textCorePublicSubpaths) {
  const exportName = `./${specifier.slice('@boaa/text-core/'.length)}`;
  if (!textCoreExports.has(exportName)) {
    failures.push(`text-core package does not expose public subpath ${exportName}`);
  }
}

for (const file of collectFiles(serverRoot)) {
  for (const { specifier, typeOnly } of moduleReferences(file)) {
    if (
      /(?:^|\/)src\/repositories\/(?:reader-defaults|reader-settings-scope|reader-query-contract)(?:\.js)?$/.test(
        specifier,
      )
    ) {
      failures.push(`${path.relative(workspaceRoot, file)} bypasses @boaa/reader-core: ${specifier}`);
    }
    if (
      /(?:^|\/)src\/(?:reader\/search-policy|integration-settings\/discovery-settings|sync\/contract)(?:\.js)?$/.test(
        specifier,
      )
    ) {
      failures.push(`${path.relative(workspaceRoot, file)} bypasses @boaa/reader-core: ${specifier}`);
    }
    if (specifier.startsWith('@boaa/reader-core') && !readerCorePublicSubpaths.has(specifier)) {
      failures.push(`${path.relative(workspaceRoot, file)} imports a private reader-core path: ${specifier}`);
    }
    if (/(?:^|\/)src\/(?:domain|sync)\/types(?:\.js)?$/.test(specifier)) {
      failures.push(`${path.relative(workspaceRoot, file)} bypasses @boaa/contracts: ${specifier}`);
    }
    if (specifier.startsWith('@boaa/contracts') && !['@boaa/contracts', '@boaa/contracts/sync'].includes(specifier)) {
      failures.push(`${path.relative(workspaceRoot, file)} imports a private contracts path: ${specifier}`);
    }
    if (['@boaa/contracts', '@boaa/contracts/sync'].includes(specifier) && !typeOnly) {
      failures.push(`${path.relative(workspaceRoot, file)} must use import type for ${specifier}`);
    }
    if (/(?:^|\/)packages\/contracts\/src(?:\/|$)/.test(specifier)) {
      failures.push(`${path.relative(workspaceRoot, file)} imports contracts source directly: ${specifier}`);
    }
    if (!typeOnly && rootTextRuntimePattern.test(specifier)) {
      failures.push(`${path.relative(workspaceRoot, file)} bypasses @boaa/text-core: ${specifier}`);
    }
    if (specifier.startsWith('@boaa/text-core') && !textCorePublicSubpaths.has(specifier)) {
      failures.push(`${path.relative(workspaceRoot, file)} imports a private text-core path: ${specifier}`);
    }
  }
}

for (const relativeFile of ['scripts/desktop-vertex-contract-smoke.ts', 'scripts/test-novel-llm-labeling-smoke.ts']) {
  const file = path.join(workspaceRoot, relativeFile);
  if (!fs.existsSync(file)) continue;
  for (const { specifier, typeOnly } of moduleReferences(file)) {
    if (!typeOnly && rootTextRuntimePattern.test(specifier)) {
      failures.push(`${relativeFile} bypasses @boaa/text-core: ${specifier}`);
    }
    if (specifier.startsWith('@boaa/text-core') && !textCorePublicSubpaths.has(specifier)) {
      failures.push(`${relativeFile} imports a private text-core path: ${specifier}`);
    }
  }
}

const domainFacade = fs.readFileSync(path.join(workspaceRoot, 'src/domain/types.ts'), 'utf8');
const syncFacade = fs.readFileSync(path.join(workspaceRoot, 'src/sync/types.ts'), 'utf8');
if (!domainFacade.includes("export type * from '@boaa/contracts'"))
  failures.push('domain type facade is not delegated');
if (!syncFacade.includes("export type * from '@boaa/contracts/sync'"))
  failures.push('sync type facade is not delegated');

if (failures.length) {
  console.error('Shared contract boundary check failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exitCode = 1;
} else {
  console.log('Shared contract boundary check passed.');
}
