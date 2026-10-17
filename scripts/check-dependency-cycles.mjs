import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const workspaceRoot = path.resolve(import.meta.dirname, '..');
const sourceRoots = [
  'src',
  'apps/server/src',
  'packages/contracts',
  'packages/text-core',
  'packages/reader-core',
  'packages/document-series-core',
];
const sourcePattern = /\.(?:ts|tsx)$/;
const testPattern = /(?:^|\/)(?:test|tests)(?:\/|$)|\.(?:test|spec)\.(?:ts|tsx)$/;

function normalize(filePath) {
  return path.relative(workspaceRoot, filePath).replaceAll('\\', '/');
}

function collectSourceFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(absolutePath));
    } else if (sourcePattern.test(entry.name) && !testPattern.test(normalize(absolutePath))) {
      files.push(path.resolve(absolutePath));
    }
  }
  return files;
}

function runtimeModuleSpecifiers(sourceFile) {
  const specifiers = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      if (!statement.importClause?.isTypeOnly) specifiers.push(statement.moduleSpecifier.text);
      continue;
    }
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      if (!statement.isTypeOnly) specifiers.push(statement.moduleSpecifier.text);
    }
  }

  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return specifiers;
}

function resolveImport(fromFile, specifier, sourceFiles) {
  const workspaceModules = {
    '@boaa/document-series-core': path.join(workspaceRoot, 'packages/document-series-core/index.ts'),
    '@boaa/document-series-core/local-archive-series': path.join(
      workspaceRoot,
      'packages/document-series-core/local-archive-series.ts',
    ),
    '@boaa/reader-core/sync-contract': path.join(workspaceRoot, 'packages/reader-core/sync-contract.ts'),
    '@boaa/reader-core/settings': path.join(workspaceRoot, 'packages/reader-core/settings.ts'),
    '@boaa/reader-core/defaults': path.join(workspaceRoot, 'packages/reader-core/defaults.ts'),
    '@boaa/reader-core/settings-scope': path.join(workspaceRoot, 'packages/reader-core/settings-scope.ts'),
    '@boaa/reader-core/search-policy': path.join(workspaceRoot, 'packages/reader-core/search-policy.ts'),
    '@boaa/reader-core/query-contract': path.join(workspaceRoot, 'packages/reader-core/query-contract.ts'),
    '@boaa/reader-core/discovery-settings': path.join(workspaceRoot, 'packages/reader-core/discovery-settings.ts'),
    '@boaa/contracts': path.join(workspaceRoot, 'packages/contracts/index.ts'),
    '@boaa/contracts/sync': path.join(workspaceRoot, 'packages/contracts/sync.ts'),
    '@boaa/text-core/hash': path.join(workspaceRoot, 'packages/text-core/hash.ts'),
    '@boaa/text-core/legacy-hash': path.join(workspaceRoot, 'packages/text-core/legacy-hash.ts'),
    '@boaa/text-core/normalization': path.join(workspaceRoot, 'packages/text-core/normalization.ts'),
    '@boaa/text-core/chapter-structure': path.join(workspaceRoot, 'packages/text-core/chapter-structure.ts'),
    '@boaa/text-core/speaker-attribution': path.join(workspaceRoot, 'packages/text-core/speaker-attribution.ts'),
    '@boaa/text-core/library-metadata': path.join(workspaceRoot, 'packages/text-core/library-metadata.ts'),
    '@boaa/text-core/image-format': path.join(workspaceRoot, 'packages/text-core/image-format.ts'),
    '@boaa/text-core/parser': path.join(workspaceRoot, 'packages/text-core/parser.ts'),
    '@boaa/text-core/identity/parser': path.join(workspaceRoot, 'packages/text-core/identity/parser.ts'),
    '@boaa/text-core/identity/reader': path.join(workspaceRoot, 'packages/text-core/identity/reader.ts'),
    '@boaa/text-core/identity/ai': path.join(workspaceRoot, 'packages/text-core/identity/ai.ts'),
    '@boaa/text-core/identity/provider': path.join(workspaceRoot, 'packages/text-core/identity/provider.ts'),
    '@boaa/text-core/identity/sync': path.join(workspaceRoot, 'packages/text-core/identity/sync.ts'),
    '@boaa/text-core/identity/tts': path.join(workspaceRoot, 'packages/text-core/identity/tts.ts'),
    '@boaa/text-core/identity/workflow': path.join(workspaceRoot, 'packages/text-core/identity/workflow.ts'),
  };
  const unresolved = specifier.startsWith('.')
    ? path.resolve(path.dirname(fromFile), specifier)
    : workspaceModules[specifier];
  if (!unresolved) return undefined;
  const withoutJsExtension = unresolved.replace(/\.(?:c|m)?js$/, '');
  const candidates = [
    unresolved,
    `${unresolved}.ts`,
    `${unresolved}.tsx`,
    `${withoutJsExtension}.ts`,
    `${withoutJsExtension}.tsx`,
    path.join(unresolved, 'index.ts'),
    path.join(unresolved, 'index.tsx'),
  ].map((candidate) => path.resolve(candidate));
  return candidates.find((candidate) => sourceFiles.has(candidate));
}

function stronglyConnectedComponents(graph) {
  let nextIndex = 0;
  const indexByNode = new Map();
  const lowLinkByNode = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];

  function visit(node) {
    indexByNode.set(node, nextIndex);
    lowLinkByNode.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);

    for (const adjacent of graph.get(node) ?? []) {
      if (!indexByNode.has(adjacent)) {
        visit(adjacent);
        lowLinkByNode.set(node, Math.min(lowLinkByNode.get(node), lowLinkByNode.get(adjacent)));
      } else if (onStack.has(adjacent)) {
        lowLinkByNode.set(node, Math.min(lowLinkByNode.get(node), indexByNode.get(adjacent)));
      }
    }

    if (lowLinkByNode.get(node) !== indexByNode.get(node)) return;
    const component = [];
    let member;
    do {
      member = stack.pop();
      onStack.delete(member);
      component.push(member);
    } while (member !== node);
    components.push(component);
  }

  for (const node of graph.keys()) {
    if (!indexByNode.has(node)) visit(node);
  }
  return components;
}

function representativeCycle(component, graph) {
  const members = new Set(component);
  const start = [...component].sort((left, right) => normalize(left).localeCompare(normalize(right)))[0];
  const pathStack = [];
  const visiting = new Set();

  function find(node) {
    pathStack.push(node);
    visiting.add(node);
    for (const adjacent of graph.get(node) ?? []) {
      if (!members.has(adjacent)) continue;
      const cycleStart = pathStack.indexOf(adjacent);
      if (cycleStart >= 0) return [...pathStack.slice(cycleStart), adjacent];
      if (!visiting.has(adjacent)) {
        const found = find(adjacent);
        if (found) return found;
      }
    }
    visiting.delete(node);
    pathStack.pop();
    return undefined;
  }

  return find(start) ?? [...component, component[0]];
}

const files = sourceRoots.flatMap((root) => collectSourceFiles(path.join(workspaceRoot, root)));
const sourceFiles = new Set(files);
const graph = new Map(files.map((file) => [file, new Set()]));

for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  for (const specifier of runtimeModuleSpecifiers(sourceFile)) {
    const target = resolveImport(file, specifier, sourceFiles);
    if (target) graph.get(file).add(target);
  }
}

const cycles = stronglyConnectedComponents(graph).filter(
  (component) => component.length > 1 || graph.get(component[0])?.has(component[0]),
);

if (cycles.length) {
  console.error(`Dependency cycle check failed with ${cycles.length} runtime cycle(s):`);
  cycles
    .map((component) => representativeCycle(component, graph).map(normalize).join(' -> '))
    .sort()
    .forEach((cycle) => console.error(`- ${cycle}`));
  process.exitCode = 1;
} else {
  const edgeCount = [...graph.values()].reduce((total, edges) => total + edges.size, 0);
  console.log(`Dependency cycle check passed for ${files.length} modules and ${edgeCount} relative imports.`);
}
