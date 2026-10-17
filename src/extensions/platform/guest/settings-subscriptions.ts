import { isUiJson, uiRecord, uiKeys, uiInteger, type UiJson } from '@boaa/extension-contracts/ui-json';
export type SettingsSnapshot = { schemaVersion: number; revision: number; value: Record<string, UiJson> } | null;
type Listener = (snapshot: SettingsSnapshot) => unknown;
interface Subscription {
  listener: Listener;
  revision: number;
  running: boolean;
  latest?: { value: SettingsSnapshot };
}
/** One pending latest snapshot per callback; no replay queue of intermediate revisions. */
export class SettingsSubscriptions {
  private sequence = 0;
  private closed = false;
  private subscriptions = new Map<number, Subscription>();
  constructor(
    private request: (method: string, input: UiJson) => Promise<UiJson>,
    private fail: () => void,
  ) {}
  async subscribe(listener: Listener): Promise<{ dispose(): Promise<void> }> {
    if (this.closed || typeof listener !== 'function' || this.subscriptions.size >= 8)
      throw Error('SUBSCRIPTION_LIMIT');
    const id = ++this.sequence;
    const subscription: Subscription = { listener, revision: -1, running: false };
    this.subscriptions.set(id, subscription);
    try {
      const value = await this.request('settings.watch', { subscription: id });
      if (this.closed) throw Error('VIEW_CLOSED');
      this.receive(id, value);
    } catch (error) {
      this.subscriptions.delete(id);
      // A timed-out watch may have reached the host. Close instead of leaving an invisible registration.
      if (!(error instanceof Error && ['REQUEST_DENIED', 'REQUEST_LIMIT'].includes(error.message))) this.fail();
      throw error;
    }
    return Object.freeze({
      dispose: async () => {
        if (!this.subscriptions.delete(id) || this.closed) return;
        subscription.latest = undefined;
        try {
          await this.request('settings.unwatch', { subscription: id });
        } catch (error) {
          this.fail();
          throw error;
        }
      },
    });
  }
  receive(id: number, value: unknown): void {
    if (this.closed) return;
    const s = this.subscriptions.get(id);
    if (!s) return;
    if (
      !isUiJson(value, 65536) ||
      !(
        value === null ||
        (uiRecord(value) &&
          uiKeys(value, ['schemaVersion', 'revision', 'value']) &&
          uiInteger(value.schemaVersion, 1, Number.MAX_SAFE_INTEGER) &&
          uiInteger(value.revision, 1, Number.MAX_SAFE_INTEGER) &&
          uiRecord(value.value))
      )
    )
      throw Error('INVALID_CONFIG');
    const snapshot = value as SettingsSnapshot;
    const revision = snapshot?.revision ?? 0;
    if (revision <= s.revision) return;
    s.revision = revision;
    s.latest = { value: snapshot };
    if (!s.running) void this.drain(id, s);
  }
  private async drain(id: number, s: Subscription) {
    s.running = true;
    try {
      while (!this.closed && this.subscriptions.get(id) === s && s.latest) {
        const { value } = s.latest;
        s.latest = undefined;
        await s.listener(value);
      }
    } catch {
      this.close();
      this.fail();
    } finally {
      s.running = false;
    }
  }
  close(): void {
    this.closed = true;
    for (const s of this.subscriptions.values()) s.latest = undefined;
    this.subscriptions.clear();
  }
}
