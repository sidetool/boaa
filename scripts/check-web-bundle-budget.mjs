import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { inventoryWebBundle } from './performance/web-bundle-inventory.mjs';

const workspaceRoot = path.resolve(import.meta.dirname, '..');
const { values } = parseArgs({
  options: {
    dist: { type: 'string', default: path.join(workspaceRoot, 'dist') },
    json: { type: 'string' },
    strict: { type: 'boolean', default: false },
  },
});
const distRoot = path.resolve(values.dist);
const budgets = {
  entryJsRaw: Number.parseInt(process.env.BUNDLE_ENTRY_JS_RAW_MAX ?? '660000', 10),
  entryJsGzip: Number.parseInt(process.env.BUNDLE_ENTRY_JS_GZIP_MAX ?? '186000', 10),
  entryCssRaw: Number.parseInt(process.env.BUNDLE_ENTRY_CSS_RAW_MAX ?? '56000', 10),
  entryCssGzip: Number.parseInt(process.env.BUNDLE_ENTRY_CSS_GZIP_MAX ?? '10000', 10),
};

function assertBudgetConfiguration() {
  for (const [name, value] of Object.entries(budgets)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid bundle budget ${name}: ${value}`);
  }
}

function formatBytes(value) {
  return `${(value / 1024).toFixed(1)} KiB`;
}

function enforce(label, actual, maximum, failures) {
  if (actual <= maximum) return;
  failures.push(`${label}: ${formatBytes(actual)} exceeds ${formatBytes(maximum)}`);
}

assertBudgetConfiguration();
const inventory = inventoryWebBundle(distRoot);
const totals = {
  entryJsRaw: inventory.initial.js.raw,
  entryJsGzip: inventory.initial.js.gzip,
  entryCssRaw: inventory.initial.css.raw,
  entryCssGzip: inventory.initial.css.gzip,
};
const failures = [];
enforce('entry JS raw', totals.entryJsRaw, budgets.entryJsRaw, failures);
enforce('entry JS gzip', totals.entryJsGzip, budgets.entryJsGzip, failures);
enforce('entry CSS raw', totals.entryCssRaw, budgets.entryCssRaw, failures);
enforce('entry CSS gzip', totals.entryCssGzip, budgets.entryCssGzip, failures);

console.log(
  `Web initial static graph: JS ${formatBytes(totals.entryJsRaw)} raw / ${formatBytes(totals.entryJsGzip)} gzip; ` +
    `CSS ${formatBytes(totals.entryCssRaw)} raw / ${formatBytes(totals.entryCssGzip)} gzip.`,
);
console.log(
  `Deferred JS: ${formatBytes(inventory.deferred.js.raw)} raw; manifest assets: ${formatBytes(inventory.assets.all.raw)} raw.`,
);
if (values.json) fs.writeFileSync(values.json, `${JSON.stringify({ ...inventory, budgets, failures }, null, 2)}\n`);
if (failures.length) {
  console.warn('Web bundle diagnostic crossed a historical threshold:');
  failures.forEach((failure) => console.warn(`- ${failure}`));
  console.warn(
    values.strict
      ? 'Strict bundle check failed.'
      : 'This is advisory; decide from measured initial-load and interaction performance.',
  );
  if (values.strict) process.exitCode = 1;
} else {
  console.log('Web bundle diagnostic is within the recorded thresholds.');
}
