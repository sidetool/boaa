/** Read only the structured bootstrap event; never echo container logs or the code. */
export function setupCodeFromLogs(logs) {
  let code;
  for (const line of logs.split(/\r?\n/)) {
    try {
      const entry = JSON.parse(line.slice(line.indexOf('{')));
      if (entry.event === 'owner_setup_code' && /^[2-9A-HJ-NP-Z]{4}(?:-[2-9A-HJ-NP-Z]{4}){2}$/.test(entry.setupCode))
        code = entry.setupCode;
    } catch {
      /* Non-JSON container output is unrelated. */
    }
  }
  return code;
}

export async function readHostedSetupCode({
  apiUrl,
  readLogs,
  timeoutMs,
  fetchStatus = fetch,
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetchStatus(`${apiUrl.replace(/\/+$/, '')}/auth/status`, {
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) {
        const status = await response.json();
        if (!status.setupRequired) return undefined;
        const code = setupCodeFromLogs(await readLogs());
        if (code) return code;
      }
    } catch {
      /* Startup may not have completed. Retry without printing credentials. */
    }
    await pause(250);
  }
  throw new Error('Owner setup code unavailable in API logs; bootstrap was not bypassed.');
}
