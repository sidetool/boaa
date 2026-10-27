import { createSpeakerEngineServer } from './server';
const server = createSpeakerEngineServer(process.env.SPEAKER_ENGINE_TOKEN ?? '');
server.listen(Number(process.env.PORT ?? 8095), process.env.HOST ?? '0.0.0.0');
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => server.close());
