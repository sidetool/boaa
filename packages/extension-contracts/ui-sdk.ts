import type { UiMethodMap, SharedSelection } from './ui-dto';
import type { UiContext } from './ui-lifecycle';
export type UiDisposable = () => void | Promise<void>;
export interface UiInvocation {
  readonly invocationId: string;
  readonly selectionToken?: string;
  readonly signal: AbortSignal;
}
export interface UiPluginContext {
  readonly runtime: { getCapabilities(): Promise<UiMethodMap['runtime.getCapabilities']['result']> };
  readonly storage: {
    get(params: UiMethodMap['storage.get']['params']): Promise<UiMethodMap['storage.get']['result']>;
    set(params: UiMethodMap['storage.set']['params']): Promise<UiMethodMap['storage.set']['result']>;
    remove(params: UiMethodMap['storage.remove']['params']): Promise<UiMethodMap['storage.remove']['result']>;
    list(params: UiMethodMap['storage.list']['params']): Promise<UiMethodMap['storage.list']['result']>;
  };
  readonly commands: {
    register(commandId: string, handler: (invocation: UiInvocation) => void | Promise<void>): Promise<UiDisposable>;
  };
  readonly reader: { consumeSelection(token: string): Promise<SharedSelection> };
  readonly ui: {
    readonly context: Readonly<UiContext>;
    onContextChanged(handler: (value: Readonly<UiContext>) => void): UiDisposable;
  };
  readonly subscriptions: { add(dispose: UiDisposable): UiDisposable };
}
export interface UiPluginDefinition {
  readonly apiVersion: 1;
  activate(context: UiPluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
export interface BoaaPluginApi {
  register(definition: UiPluginDefinition): void;
}
