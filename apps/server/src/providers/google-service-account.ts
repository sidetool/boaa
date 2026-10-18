import { createPrivateKey } from 'node:crypto';

export interface GoogleServiceAccount {
  readonly type: 'service_account';
  readonly project_id: string;
  readonly client_email: string;
  readonly private_key: string;
  readonly token_uri: 'https://oauth2.googleapis.com/token';
}

/** Only accept Google service-account keys, never executable/external-account ADC configurations. */
export function parseGoogleServiceAccount(value: string): GoogleServiceAccount {
  const invalid = () => new Error('A valid Google service account JSON key is required');
  if (Buffer.byteLength(value, 'utf8') > 65_536) throw invalid();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(value);
  } catch {
    throw invalid();
  }
  if (
    !data ||
    data.type !== 'service_account' ||
    typeof data.project_id !== 'string' ||
    !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(data.project_id) ||
    typeof data.client_email !== 'string' ||
    !/^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.gserviceaccount\.com$/.test(data.client_email) ||
    typeof data.private_key !== 'string' ||
    (data.token_uri !== undefined && data.token_uri !== 'https://oauth2.googleapis.com/token') ||
    (data.universe_domain !== undefined && data.universe_domain !== 'googleapis.com')
  )
    throw invalid();
  try {
    const key = createPrivateKey(data.private_key);
    if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw invalid();
  } catch {
    throw invalid();
  }
  // Drop all extra configuration and endpoint fields before passing credentials to an SDK.
  return {
    type: 'service_account',
    project_id: data.project_id,
    client_email: data.client_email,
    private_key: data.private_key,
    token_uri: 'https://oauth2.googleapis.com/token',
  };
}
