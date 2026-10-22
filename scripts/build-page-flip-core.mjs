import { readFileSync, writeFileSync } from 'node:fs';
import ts from 'typescript';

// Deliberately compile only the upstream geometry, not its DOM ownership,
// input listeners or permanent RAF loop. The original sources stay unmodified.
const root = new URL('../', import.meta.url);
const source = (name) => readFileSync(new URL(`third_party/st-page-flip/${name}`, root), 'utf8');
const enums = source('src/Flip/Flip.ts').match(
  /export const enum FlipDirection[\s\S]*?(?=\/\*\*\s*\n \* State of the book)/,
)?.[0];
if (!enums) throw new Error('Upstream enum declarations changed');
const inputs = [enums, source('src/Helper.ts'), source('src/Flip/FlipCalculation.ts')];
const code = inputs.map((input) => input.replace(/^import .*;\r?\n/gm, '')).join('\n');
const { outputText } = ts.transpileModule(code, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ES2020, removeComments: false },
});
const notice = `/*! StPageFlip 2.0.7, Copyright (c) 2020 Nodlik, MIT.\n${source('LICENSE')}\n*/\n`;
const target = new URL('src/features/reader/vendor/st-page-flip.mjs', root);
const generated = notice + outputText;
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== generated) throw new Error('Generated page-flip core is out of date');
} else {
  writeFileSync(target, generated);
}
