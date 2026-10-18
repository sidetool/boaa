import { spawnWithBudget } from './process-budget.mjs';
import { readdir, rename } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHash, createDecipheriv } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { ApkWorkerSupervisor } from './supervisor.mjs';

/** No shell commands, inherited credentials, or full server JARs. Paths originate only from the installation store. */
export async function createJavaApkTools(
  java,
  build,
  { systemRoot = process.env.SystemRoot, resolveDefaultProxy = () => undefined, processBudget } = {},
) {
  const env = systemRoot ? { SystemRoot: systemRoot } : {};
  const dependencies = (await readdir(join(build, 'dependencies'))).filter((name) => name.endsWith('.jar'));
  const main = join(build, 'target', 'apk-worker-0.1.0.jar');
  const toolsPath = [main, ...dependencies.map((name) => join(build, 'dependencies', name))].join(delimiter);
  const runtimePath = [
    main,
    ...dependencies
      .filter((name) => !/^(?:dex-|d2j-|asm-|antlr|apk-parser-|apksig-)/.test(name))
      .map((name) => join(build, 'dependencies', name)),
  ].join(delimiter);
  const networkKey = createHash('sha256').update('moya.host.network').digest('hex');
  const networkStates = new Map();
  function legacyNetworkOptions(directory) {
    const legacy = join(directory, networkKey + '.json');
    try {
      if (statSync(legacy).size > 1024 * 1024) throw new Error('preferences_limit');
      return JSON.parse(readFileSync(legacy, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw error;
    }
  }
  function networkOptions(directory) {
    const file = join(directory, 'preferences.enc');
    let version;
    try {
      const info = statSync(file, { bigint: true });
      if (info.size > 16n * 1024n * 1024n) throw new Error('preferences_limit');
      version = `${info.mtimeNs}:${info.size}`;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return legacyNetworkOptions(directory);
    }
    const cached = networkStates.get(directory);
    if (cached?.version === version) return cached.options;
    // Match the private Java PreferenceStorage AES-GCM envelope. Never write plaintext.
    const bytes = readFileSync(file),
      key = readFileSync(join(directory, 'preferences.key'));
    if (bytes.length < 29 || bytes[0] !== 1 || key.length !== 32) throw new Error('preferences_unavailable');
    const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(1, 13));
    cipher.setAuthTag(bytes.subarray(-16));
    const values = JSON.parse(Buffer.concat([cipher.update(bytes.subarray(13, -16)), cipher.final()]).toString('utf8'));
    const options = values[networkKey] ?? {};
    if (networkStates.size >= 128) networkStates.delete(networkStates.keys().next().value);
    networkStates.set(directory, { version, options });
    return options;
  }
  async function tool(args, signal) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const child = spawnWithBudget(
        java,
        ['-Xmx256m', '-cp', toolsPath, ...args],
        {
          env,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
        processBudget,
      );
      const parts = [];
      let length = 0;
      let failure;
      const fail = (code) => {
        failure = code;
        child.kill('SIGKILL');
      };
      const cancel = () => fail('cancelled');
      signal.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(() => fail('apk_tool_timeout'), 60000);
      child.stdout.on('data', (part) => {
        length += part.length;
        if (length > 1024 * 1024) fail('apk_tool_output_limit');
        else parts.push(part);
      });
      child.stderr.on('data', () => {});
      child.on('error', () => {
        failure = 'apk_worker_unavailable';
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        if (failure || code !== 0) reject(new Error(failure ?? 'apk_verification_failed'));
        else resolve(Buffer.concat(parts).toString('utf8'));
      });
    });
  }
  function worker(archive, metadata, directory) {
    const process = new ApkWorkerSupervisor(
      java,
      [
        '-Xmx192m',
        '-cp',
        [runtimePath, archive].join(delimiter),
        'org.boaa.apk.Main',
        metadata.entry,
        directory,
        metadata.pkg,
        resolveDefaultProxy() ?? '',
      ],
      { env, pagesTimeoutMs: 165000, chaptersTimeoutMs: 600000, processBudget },
    );
    return {
      get busy() {
        return process.busy;
      },
      request: (method, params = {}, signal) =>
        process.request(method, { ...params, defaultProxy: resolveDefaultProxy() ?? '' }, signal),
      close: () => process.close(),
    };
  }
  return {
    worker,
    // Fingerprint only the effective transport, so source-written caches do not invalidate active requests.
    networkIdentity(directory) {
      const options = networkOptions(directory);
      const mode = options.mode ?? (options.proxy ? 'custom' : 'inherit');
      if (!['inherit', 'direct', 'custom'].includes(mode)) throw new Error('invalid_proxy_mode');
      const proxy = mode === 'direct' ? '' : mode === 'custom' ? options.proxy : (resolveDefaultProxy() ?? '');
      if (mode === 'custom' && !proxy) throw new Error('invalid_proxy');
      return createHash('sha256')
        .update(proxy ? new URL(proxy).href : '')
        .digest('hex');
    },
    inspect: async (archive, signal) => JSON.parse(await tool(['org.boaa.apk.Inspect', archive], signal)),
    convert: async (archive, target, signal) => {
      const staged = target + '.' + randomUUID() + '.tmp';
      await tool(['com.googlecode.dex2jar.tools.Dex2jarCmd', archive, '-o', staged, '-f', '-dsn'], signal);
      signal.throwIfAborted();
      await rename(staged, target);
    },
    describe: async (archive, metadata, directory, signal) => {
      const child = worker(archive, metadata, directory);
      try {
        return await child.request('describe', {}, signal);
      } finally {
        child.close();
      }
    },
  };
}
