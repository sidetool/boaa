import { runtimeToken } from './common.mjs';
const response = await fetch(`http://127.0.0.1:${process.env.BOAA_RUNTIME_PORT || 8791}/healthz`, {
  headers: { authorization: `Bearer ${await runtimeToken()}` },
  signal: AbortSignal.timeout(3000),
});
const manifest = await response.json();
if (!response.ok || manifest.schemaVersion !== 1 || manifest.protocolVersion !== 1 || manifest.status !== 'ready')
  process.exitCode = 1;
