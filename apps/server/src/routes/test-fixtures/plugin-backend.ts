import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
/** Synthetic backends only. Listen on one local RFC1918 address, never 0.0.0.0. */
export async function testPluginBackend(name: string) {
  const ip = Object.values(networkInterfaces())
    .flat()
    .find((n) => n?.family === 'IPv4' && /^172\.(1[6-9]|2\d|3[01])\./.test(n.address))?.address;
  if (!ip) throw Error('A local Docker RFC1918 interface is required for the opt-in LAN proof');
  const requests: {
    method: string;
    url: string;
    authenticated: boolean;
    body: string;
    completed: boolean;
    cancelled: boolean;
  }[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const record = {
      method: req.method!,
      url: req.url!,
      authenticated:
        req.headers.authorization === 'Bearer synthetic-plugin-key' ||
        req.headers['x-api-key'] === 'synthetic-plugin-key',
      body,
      completed: false,
      cancelled: false,
    };
    requests.push(record);
    res.once('finish', () => {
      record.completed = true;
    });
    res.once('close', () => {
      if (!res.writableEnded) record.cancelled = true;
    });
    const answer = () => {
      res.setHeader('content-type', 'application/json');
      res.setHeader('set-cookie', 'must-not-reach-guest=1');
      res.end(
        JSON.stringify(
          name === 'notes'
            ? { service: name, method: req.method, text: body }
            : { provider: name, value: body.toUpperCase() },
        ),
      );
    };
    if (req.url?.includes('empty')) {
      res.statusCode = 204;
      res.end();
      return;
    }
    if (req.url?.includes('disconnect')) {
      req.socket.destroy();
      return;
    }
    if (req.url?.includes('redirect')) {
      res.writeHead(302, { location: '/v1/forbidden-redirect' });
      res.end('redirect');
      return;
    }
    if (req.url?.includes('large')) {
      res.end('x'.repeat(26000));
      return;
    }
    if (req.url?.includes('slow')) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        answer();
      }, 3000);
      timers.add(timer);
      return;
    }
    if (req.url?.includes('denied')) res.statusCode = 429;
    answer();
  });
  await new Promise<void>((resolve) => server.listen(0, ip, resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw Error('BACKEND_START_FAILED');
  return {
    origin: `http://${ip}:${addr.port}`,
    requests,
    close: async () => {
      for (const timer of timers) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
