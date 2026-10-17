export type PluginSettingsFailureCode =
  | 'operation_failed'
  | 'migration_requires_disabled'
  | 'disable_revoke_failed'
  | 'remove_revoke_failed'
  | 'missing_config';
export interface PluginSettingsFailure {
  code: PluginSettingsFailureCode;
  cause?: unknown;
}
export class PluginSettingsError extends Error {
  constructor(readonly code: PluginSettingsFailureCode) {
    super(code);
  }
}
export function pluginSettingsFailure(cause: unknown): PluginSettingsFailure {
  return cause instanceof PluginSettingsError ? { code: cause.code, cause } : { code: 'operation_failed', cause };
}
