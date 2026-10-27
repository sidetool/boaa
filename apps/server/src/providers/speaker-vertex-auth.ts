import { createHash, sign } from 'node:crypto';
import type { SpeakerEngineInput } from '../../../../src/providers/speaker-engine';
import { parseGoogleServiceAccount } from './google-service-account.js';
import { connectionError } from './tts-connection-config.js';

type TokenRequest = (body: URLSearchParams) => Promise<Record<string, unknown>>;

/** Bounded, connection-keyed OAuth cache. Only sanitized Google service-account credentials are accepted. */
export class SpeakerVertexAuth {
  private tokens = new Map<string, { token: string; expires: number }>();
  async headers(v: SpeakerEngineInput, signal: AbortSignal, request: TokenRequest): Promise<Record<string, string>> {
    signal.throwIfAborted();
    let account;
    try {
      account = parseGoogleServiceAccount(v.serviceAccountJson ?? '');
    } catch {
      throw connectionError('Vertex AI의 서비스 계정 JSON 키를 등록해 주세요.');
    }
    const key = createHash('sha256').update(JSON.stringify(account)).digest('hex');
    const cached = this.tokens.get(key);
    if (cached && cached.expires > Date.now()) {
      this.tokens.delete(key);
      this.tokens.set(key, cached);
      return { Authorization: `Bearer ${cached.token}` };
    }
    this.tokens.delete(key);
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned =
      encode({ alg: 'RS256', typ: 'JWT' }) +
      '.' +
      encode({
        iss: account.client_email,
        scope: 'https://www.googleapis.com/auth/cloud-platform',
        aud: account.token_uri,
        iat: now,
        exp: now + 3600,
      });
    const assertion =
      unsigned + '.' + sign('RSA-SHA256', Buffer.from(unsigned), account.private_key).toString('base64url');
    const data = await request(
      new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    );
    signal.throwIfAborted();
    const token = data.access_token;
    if (typeof token !== 'string' || !token || token.length > 8192 || /\s/.test(token))
      throw connectionError('Vertex AI 인증 응답을 확인하지 못했어요.', 502);
    const seconds = Math.min(3600, Number(data.expires_in ?? 3600));
    if (Number.isFinite(seconds) && seconds > 60) {
      while (this.tokens.size >= 16) this.tokens.delete(this.tokens.keys().next().value!);
      this.tokens.set(key, { token, expires: Date.now() + (seconds - 60) * 1000 });
    }
    return { Authorization: `Bearer ${token}` };
  }
}
