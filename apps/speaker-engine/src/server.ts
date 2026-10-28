import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { step, attributionStep, ENGINE_VERSION } from './engine';
import { SPEAKER_ENGINE_PROTOCOL } from '../../../src/providers/speaker-engine-protocol';

export function createSpeakerEngineServer(token: string) {
  if (!token || token.length < 24) throw new Error('SPEAKER_ENGINE_TOKEN must contain at least 24 characters');
  const expected = Buffer.from('Bearer ' + token);
  return http.createServer({ requestTimeout: 30_000, headersTimeout: 10_000 }, async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    const received = Buffer.from(req.headers.authorization ?? '');
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      res.writeHead(401);
      res.end('{"error":"unauthorized"}');
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/capabilities') {
      res.end(
        JSON.stringify({
          protocol: SPEAKER_ENGINE_PROTOCOL,
          engineVersion: ENGINE_VERSION,
          maxChapterCharacters: 120000,
          attributionPreparation: true,
          performanceAnnotations: true,
        }),
      );
      return;
    }
    if (req.method !== 'POST' || !['/v1/step', '/v1/attribution'].includes(req.url ?? '')) {
      res.writeHead(404);
      res.end('{}');
      return;
    }
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 16 * 1024 * 1024) {
          res.writeHead(413);
          res.end('{"error":"input_too_large"}');
          req.destroy();
          return;
        }
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const output = req.url === '/v1/attribution' ? attributionStep(input) : step(input);
      const text = JSON.stringify(output);
      if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw new Error('state_too_large');
      res.end(text);
    } catch {
      // Model replies and source excerpts never belong in HTTP errors or operational logs.
      res.writeHead(422);
      res.end('{"error":"analysis_contract_rejected"}');
    }
  });
}
