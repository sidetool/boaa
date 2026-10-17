import { isUiJson, uiRecord } from '@boaa/extension-contracts/ui-json';
import { UiStoreError, requireStore } from '../ui/store-model';
/** Only opaque instance IDs cross tabs. Unknown owners are never assumed dead. */
export class RuntimeOwners {
  private channel?: BroadcastChannel;
  private ids = new Set<string>();
  private checks = new Set<() => void>();
  constructor() {
    if (typeof BroadcastChannel === 'undefined') return;
    this.channel = new BroadcastChannel('boaa.plugin-controller-owners.v1');
    this.channel.onmessage = ({ data }) => {
      if (
        !isUiJson(data, 8192) ||
        !uiRecord(data) ||
        data.kind !== 'probe' ||
        typeof data.token !== 'string' ||
        !Array.isArray(data.ids)
      )
        return;
      this.channel?.postMessage({
        kind: 'alive',
        token: data.token,
        ids: data.ids.filter((id) => typeof id === 'string' && this.ids.has(id)),
      });
    };
  }
  add(id: string) {
    this.ids.add(id);
  }
  remove(id: string) {
    this.ids.delete(id);
  }
  async assertLive(ids: string[]) {
    const pending = ids.filter((id) => !this.ids.has(id));
    if (!pending.length) return;
    const channel = this.channel;
    requireStore(channel, 'RECOVERY_REQUIRED');
    // Background tabs may not answer in 200 ms. Retry the same challenge, but
    // never infer termination from silence. Acknowledgements end the wait early.
    await new Promise<void>((resolve, reject) => {
      const token = crypto.randomUUID();
      const live = new Set<string>();
      const finish = (ok: boolean) => {
        clearTimeout(deadline);
        clearInterval(retry);
        channel.removeEventListener('message', receive);
        this.checks.delete(cancel);
        if (ok) resolve();
        else reject(new UiStoreError('RECOVERY_REQUIRED'));
      };
      const cancel = () => finish(false);
      const receive = ({ data }: MessageEvent) => {
        if (
          !isUiJson(data, 8192) ||
          !uiRecord(data) ||
          data.kind !== 'alive' ||
          data.token !== token ||
          !Array.isArray(data.ids)
        )
          return;
        for (const id of data.ids) if (typeof id === 'string' && pending.includes(id)) live.add(id);
        if (pending.every((id) => live.has(id))) finish(true);
      };
      const probe = () => {
        try {
          channel.postMessage({ kind: 'probe', token, ids: pending });
        } catch {
          cancel();
        }
      };
      const deadline = setTimeout(cancel, 2000);
      const retry = setInterval(probe, 500);
      this.checks.add(cancel);
      channel.addEventListener('message', receive);
      probe();
    });
  }

  close() {
    for (const cancel of this.checks) cancel();
    this.ids.clear();
    this.channel?.close();
    this.channel = undefined;
  }
}
