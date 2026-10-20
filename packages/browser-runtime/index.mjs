import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

export function browserEngine(env = process.env) {
  const engine = env.BOAA_BROWSER_ENGINE || (env.BOAA_CAMOUFOX_EXECUTABLE ? 'camoufox' : 'patchright');
  if (!['patchright', 'camoufox'].includes(engine)) throw new Error('source_browser_engine_invalid');
  return engine;
}
export const BROWSER_ENGINE = browserEngine();
export function browserDriverVersion(engine = browserEngine()) {
  return engine === 'patchright' ? '1.61.1' : '1.62.0';
}
export async function browserLauncher(engine = browserEngine()) {
  return engine === 'patchright'
    ? (await import('patchright-core')).chromium
    : (await import('playwright-core')).firefox;
}
export async function browserLaunchOptions(engine = browserEngine()) {
  if (engine === 'camoufox') return camoufoxLaunchOptions();
  return {
    headless: true,
    channel: 'chromium',
    ...(process.env.BOAA_PATCHRIGHT_EXECUTABLE ? { executablePath: process.env.BOAA_PATCHRIGHT_EXECUTABLE } : {}),
    args: ['--proxy-bypass-list=<-loopback>'],
  };
}
export const BROWSER_DRIVER_VERSION = '1.62.0';
const execute = promisify(execFile);

/** Official fingerprint generation, without logging inherited environment or downloading at launch. */
export async function camoufoxLaunchOptions() {
  try {
    const { stdout } = await execute(
      process.env.BOAA_CAMOUFOX_OPTIONS_EXECUTABLE ||
        process.env.BOAA_CAMOUFOX_PYTHON ||
        (process.platform === 'win32' ? 'python' : 'python3'),
      process.env.BOAA_CAMOUFOX_OPTIONS_EXECUTABLE
        ? ['--camoufox-launch-options']
        : [fileURLToPath(new URL('./launch-options.py', import.meta.url))],
      { timeout: 25000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
    );
    const prefix = '__BOAA_CAMOUFOX_OPTIONS__';
    const row = stdout.split('\n').find((line) => line.startsWith(prefix));
    const options = JSON.parse(row?.slice(prefix.length) ?? '');
    if (!options.executablePath || !options.env || options.headless !== true) throw new Error();
    return options;
  } catch {
    // execFile errors include stdout/stderr, which may contain launch credentials. Never propagate them.
    throw new Error('source_browser_unavailable');
  }
}

/** Maker scripts need the page world on both engines (not an automation isolated world). */
export function evaluateBrowserScript(page, script, engine = browserEngine()) {
  return engine === 'camoufox' ? page.evaluate('mw:' + script) : page.evaluate(script, undefined, false);
}
