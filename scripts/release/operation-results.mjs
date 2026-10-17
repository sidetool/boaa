/** Keep enough completed requests for reconnecting tabs without growing the mailbox indefinitely. */
export const OPERATION_RESULT_LIMIT = 32;

export function recordOperationResult(state, operation, outcome, error) {
  if (!operation?.id) return;
  operation.completedAt ||= new Date().toISOString();
  const result = { ...operation, outcome, ...(error ? { error } : {}) };
  state.operationResults = [...(state.operationResults || []).filter((item) => item.id !== operation.id), result].slice(
    -OPERATION_RESULT_LIMIT,
  );
}
