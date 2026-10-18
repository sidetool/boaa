import type { FastifyRequest } from 'fastify';
import { requireUserId } from '../auth.js';
import type { ServerConfig } from '../config.js';

/** Immutable compatibility adapter for services whose owner argument is still named defaultUserId. */
export function requestOwnerConfig(config: ServerConfig, request: FastifyRequest): ServerConfig {
  return Object.freeze({ ...config, defaultUserId: requireUserId(request) });
}
