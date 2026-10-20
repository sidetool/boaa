// Build-time only: retain the notices shipped by this exact browser binary.
import { chromium } from 'patchright-core';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';

const directory = '/licenses/chromium';
const executable = chromium.executablePath();
const hash = createHash('sha256');
for await (const chunk of createReadStream(executable)) hash.update(chunk);
const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  await page.goto('chrome://credits', { waitUntil: 'load' });
  const credits = await page.content();
  if (credits.length < 100000 || !credits.includes('Redistribution')) throw Error('chromium_notices_missing');
  await mkdir(directory, { recursive: true });
  await writeFile(`${directory}/credits.html`, credits);
  await writeFile(
    `${directory}/inventory.json`,
    JSON.stringify({
      version: browser.version(),
      executable: executable.replace(/^\//, ''),
      executableSha256: hash.digest('hex'),
      creditsSha256: createHash('sha256').update(credits).digest('hex'),
      origin: 'chrome://credits',
    }) + '\n',
  );
} finally {
  await browser.close();
}
