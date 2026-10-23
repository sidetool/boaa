// Code-owned optional service definition. Release manifests supply only a signed image.
export const TTS_ENDPOINT = 'http://plain-tts:9010/synthesize';
export const TTS_MODEL_BYTES = 401301114;
export const TTS_MODEL_ID = 'supertonic-3-ko';
export const TTS_MODEL_REVISION = 'aafc6e32416a594460b32413efc49d7fe4ce6d46';

export function withOptionalTTS(config, project) {
  if (config.services['plain-tts']) return config;
  const next = structuredClone(config);
  next.volumes ??= {};
  next.volumes['plain-tts-models'] ??= { name: `${project}_plain-tts-models` };
  next.services['plain-tts'] = {
    image: 'ghcr.io/sidetool/boaa-tts:uninstalled',
    profiles: ['tts'],
    environment: { MODEL_AUTO_INSTALL: 'false' },
    volumes: [{ type: 'volume', source: 'plain-tts-models', target: '/models' }],
    expose: ['9010'],
    mem_limit: '1536m',
    cpus: 4,
    init: true,
    restart: 'unless-stopped',
    security_opt: ['no-new-privileges:true'],
    cap_drop: ['ALL'],
    healthcheck: {
      test: [
        'CMD',
        'python',
        '-c',
        "import urllib.request; urllib.request.urlopen('http://127.0.0.1:9010/health', timeout=3)",
      ],
      interval: '15s',
      timeout: '5s',
      retries: 8,
      start_period: '60s',
    },
    logging: { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } },
  };
  return next;
}
