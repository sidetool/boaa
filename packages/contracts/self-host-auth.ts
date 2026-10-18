export type SelfHostRole = 'admin' | 'member';
export interface SelfHostAccount {
  readonly userId: string;
  readonly username: string;
  readonly displayName: string;
  readonly role: SelfHostRole;
}
export interface SelfHostAuthenticatedContext {
  readonly account: SelfHostAccount;
  readonly serverId: string;
  readonly libraryId: string;
  readonly accountId: string;
  readonly sessionContext: string;
  readonly capabilities: {
    readonly manageAccounts: boolean;
    readonly manageServer: boolean;
    readonly manageExtensions: boolean;
    readonly useSources: boolean;
    readonly useProviders: boolean;
    readonly exportLibrary: boolean;
    readonly restoreLibrary: boolean;
  };
  readonly legacyDataOwner: boolean;
}
export interface RequestPrincipal {
  readonly userId: string;
  readonly role: SelfHostRole;
  readonly authMethod: 'session' | 'legacy-token';
  readonly sessionContext?: string;
  readonly authVersion?: number;
}
