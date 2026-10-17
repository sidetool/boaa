import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import type { ExtensionContributionId } from '@boaa/extension-contracts';
import type { ExternalItemPage } from '../../external-sources/contracts';
import {
  externalSourceSubscriptionId,
  type ExternalSourceSubscriptionRecord,
} from '../../external-sources/local-state';
import { useSourceSubscriptionRefresh } from './use-source-subscription-refresh';

type Port = Parameters<typeof useSourceSubscriptionRefresh>[0];
const sourceId = 'fixture.source' as ExtensionContributionId;
const subscription: ExternalSourceSubscriptionRecord = {
  id: externalSourceSubscriptionId(sourceId, 'account', 'work'),
  connectorId: sourceId,
  accountConnectionId: 'account',
  collectionRemoteId: 'work',
  navigationRef: 'work',
  title: 'Work',
  knownReleaseIds: [],
  newReleaseIds: [],
  availableReleaseCount: 0,
  releaseBaselineComplete: true,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  lastCheckedAt: '2026-01-01T00:00:00Z',
  schemaVersion: 1,
};
const page = (id: string): ExternalItemPage => ({
  detail: { title: 'Work' },
  items: [
    {
      key: { connectorId: sourceId, accountConnectionId: 'account', remoteId: id },
      kind: 'file',
      title: id,
      importability: 'supported',
      release: { title: id },
    },
  ],
});

async function harness(foreground = false) {
  let generation = '1';
  let records = [subscription];
  let disposed = false;
  let foregroundEnabled = foreground;
  const list = vi.fn<Port['registry']['listExternalSource']>().mockResolvedValue(page('new'));
  const save = vi.fn(async (next: ExternalSourceSubscriptionRecord) => {
    records = records.map((record) => (record.id === next.id ? next : record));
  });
  const onRecord = vi.fn();
  const onSnapshot = vi.fn();
  const notify = vi.fn();
  let control!: ReturnType<typeof useSourceSubscriptionRefresh>;
  function Probe() {
    control = useSourceSubscriptionRefresh({
      state: { listSubscriptions: async () => records, saveSubscription: save },
      registry: {
        listExternalSource: list,
        getExternalSourceStatus: () => ({
          state: 'connected',
          accountConnectionId: 'account',
          connectionGeneration: generation,
        }),
      },
      hostContext: { brokers: { get: () => undefined } },
      source: {
        id: sourceId,
        supportsSubscriptions: true,
        connection: { state: 'connected', accountConnectionId: 'account', connectionGeneration: generation },
      },
      subscriptions: records,
      busy: false,
      foreground: foregroundEnabled,
      onRecord,
      onSnapshot,
      notify,
    });
    return null;
  }
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(<Probe />);
  });
  return {
    get control() {
      return control;
    },
    list,
    save,
    onRecord,
    onSnapshot,
    notify,
    changeGeneration: () => {
      generation = '2';
    },
    setForeground: (value: boolean) =>
      act(() => {
        foregroundEnabled = value;
        root.update(<Probe />);
      }),
    dispose: () => {
      if (!disposed) {
        disposed = true;
        act(() => root.unmount());
      }
    },
  };
}

it('owns a single refresh session and ignores an older finalizer after cancellation and restart', async () => {
  const h = await harness();
  const replies: ((value: ExternalItemPage) => void)[] = [];
  h.list.mockImplementation(
    () =>
      new Promise((resolve) => {
        replies.push(resolve);
      }),
  );
  try {
    let older!: Promise<void>;
    let newer!: Promise<void>;
    await act(async () => {
      older = h.control.checkSubscriptions();
      await h.control.checkSubscriptions();
    });
    expect(h.list).toHaveBeenCalledOnce();
    await act(async () => {
      h.control.cancel();
      newer = h.control.checkSubscriptions();
    });
    expect(h.list).toHaveBeenCalledTimes(2);
    expect(h.list.mock.calls[0][3].aborted).toBe(true);
    await act(async () => {
      replies[0](page('obsolete'));
      await older;
    });
    expect(h.control.checkingSubscriptions).toBe(true);
    expect(h.save).not.toHaveBeenCalled();
    expect(h.onSnapshot).not.toHaveBeenCalled();
    await act(async () => {
      replies[1](page('current'));
      await newer;
    });
    expect(h.control.checkingSubscriptions).toBe(false);
    expect(h.save).toHaveBeenCalledOnce();
    expect(h.save.mock.calls[0][0].newReleaseIds).toEqual(['current']);
    expect(h.onSnapshot).toHaveBeenCalledOnce();
  } finally {
    h.dispose();
  }
});

it.each(['generation', 'unmount'] as const)(
  'does not persist or publish a delayed response after %s changes',
  async (change) => {
    const h = await harness();
    let finish!: (value: ExternalItemPage) => void;
    h.list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    try {
      let pending!: Promise<void>;
      await act(async () => {
        pending = h.control.checkSubscriptions();
      });
      if (change === 'generation') h.changeGeneration();
      else h.dispose();
      if (change === 'unmount') expect(h.list.mock.calls[0][3].aborted).toBe(true);
      await act(async () => {
        finish(page('stale'));
        await pending;
      });
      expect(h.save).not.toHaveBeenCalled();
      expect(h.onRecord).not.toHaveBeenCalled();
      expect(h.onSnapshot).not.toHaveBeenCalled();
      expect(h.notify).not.toHaveBeenCalled();
    } finally {
      h.dispose();
    }
  },
);

it('runs the foreground refresh once per source account while allowing explicit refreshes', async () => {
  const h = await harness(true);
  try {
    expect(h.list).toHaveBeenCalledOnce();
    h.setForeground(false);
    h.setForeground(true);
    expect(h.list).toHaveBeenCalledOnce();
    await act(async () => h.control.checkSubscriptions());
    expect(h.list).toHaveBeenCalledTimes(2);
  } finally {
    h.dispose();
  }
});
