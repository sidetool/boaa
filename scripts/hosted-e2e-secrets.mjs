import { randomBytes } from 'node:crypto';

/** Per-run credentials; callers may supply credentials when reusing an E2E volume. */
export function publicE2EEnvironment(env, authToken = '') {
  const secret = () => randomBytes(32).toString('hex');
  const token = authToken.trim() || env.HOSTED_API_AUTH_TOKEN?.trim() || env.READER_AUTH_TOKEN?.trim() || secret();
  return {
    ...env,
    READER_AUTH_TOKEN: token,
    HOSTED_API_AUTH_TOKEN: token,
    POSTGRES_PASSWORD: env.POSTGRES_PASSWORD?.trim() ? env.POSTGRES_PASSWORD : secret(),
    MINIO_ROOT_USER: env.MINIO_ROOT_USER?.trim() ? env.MINIO_ROOT_USER : randomBytes(10).toString('hex'),
    MINIO_ROOT_PASSWORD: env.MINIO_ROOT_PASSWORD?.trim() ? env.MINIO_ROOT_PASSWORD : secret(),
    PROVIDER_SECRET_ENCRYPTION_KEY: env.PROVIDER_SECRET_ENCRYPTION_KEY?.trim()
      ? env.PROVIDER_SECRET_ENCRYPTION_KEY
      : randomBytes(32).toString('base64'),
  };
}
