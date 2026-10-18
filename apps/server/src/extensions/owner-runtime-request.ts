import type { FastifyRequest } from 'fastify';
const signals = new WeakMap<FastifyRequest, AbortSignal>();
export function bindOwnerRuntimeSignal(request: FastifyRequest, signal: AbortSignal) {
  signals.set(request, signal);
}
export function ownerRuntimeSignal(request: FastifyRequest, signal: AbortSignal): AbortSignal {
  const owner = signals.get(request);
  return owner ? AbortSignal.any([owner, signal]) : signal;
}
