import { useCallback, useEffect, useRef, useState } from 'react';
import type { InstalledExtensionManager } from '../../extensions/packages/installed-extension-manager';
import { RemoteApiError } from '../../services/remote/remote-api-contracts';
import type {
  SourceNetworkDefaultMode,
  SourceNetworkSettings,
  SourceNetworkSettingsRequest,
} from '../../../packages/extension-contracts/source-network-settings';

export type SourceNetworkMode = SourceNetworkDefaultMode;

const VAULT_LOCKED = '소스 보관소의 잠금을 먼저 해제해 주세요.';
/** While ByeDPI is switched on but not answering, the server retries; the screen follows it this often. */
const BYEDPI_RETRY_POLL_MS = 5_000;

/** The server's explicit mode when it sends one; older servers are read from the switch and the address. */
export function sourceNetworkMode(settings: SourceNetworkSettings): SourceNetworkMode {
  if (settings.defaultMode) return settings.defaultMode;
  if (settings.byedpi?.enabled) return 'byedpi';
  return settings.defaultProxy ? 'custom' : 'direct';
}

function errorCode(cause: unknown): string {
  return cause instanceof Error ? cause.message : '';
}

function saveMessage(cause: unknown): { message: string; reload: boolean } {
  const code = errorCode(cause);
  if (code.includes('source_network_conflict'))
    return { message: '다른 화면에서 설정이 바뀌었어요. 새 설정을 불러왔으니 다시 골라 주세요.', reload: true };
  if (code.includes('byedpi_unavailable'))
    return { message: '이 서버에서는 ByeDPI를 쓸 수 없어요. 연결 방식은 그대로예요.', reload: true };
  if (code.includes('byedpi_start_failed'))
    return {
      message: 'ByeDPI를 시작하지 못했어요. 연결 방식은 바꾸지 않았어요. 잠시 후 다시 시도해 주세요.',
      reload: false,
    };
  if (code.includes('compatibility_preferences_invalid'))
    return { message: '프록시 주소를 확인해 주세요. http, https, socks5 주소만 쓸 수 있어요.', reload: false };
  if (code === VAULT_LOCKED) return { message: VAULT_LOCKED, reload: false };
  return { message: '저장하지 못했어요. 서버 연결 상태를 확인해 주세요.', reload: false };
}

/**
 * Host-wide default connection for source requests. Newer servers keep the saved custom address under every
 * mode (`defaultMode`); older ones clear it for 직접 연결, so this screen remembers it for the session.
 *
 * Two kinds of loads exist: what the person does (busy, messages, resets the picker) and the quiet ByeDPI health
 * refresh, which only updates the server snapshot and never touches what is being edited.
 */
export function useSourceNetworkSettingsModel(manager: InstalledExtensionManager) {
  const [snapshot, setSnapshot] = useState<SourceNetworkSettings>();
  const [address, setAddressState] = useState('');
  /** The option the person picked; differs from the saved mode until a custom address is saved. */
  const [choice, setChoiceState] = useState<SourceNetworkMode>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  /** The host has no source network settings (older server, device without the bridge): hide the panel. */
  const [unsupported, setUnsupported] = useState(false);
  /** Remembers a custom address an older server cleared for 직접 연결, so it can be picked again. */
  const remembered = useRef('');
  const operation = useRef<AbortController>();
  const background = useRef<AbortController>();
  const choiceRef = useRef<SourceNetworkMode>();
  const addressRef = useRef('');
  const snapshotRef = useRef<SourceNetworkSettings>();

  const setChoice = (value: SourceNetworkMode | undefined) => {
    choiceRef.current = value;
    setChoiceState(value);
  };
  const setAddressValue = (value: string) => {
    addressRef.current = value;
    setAddressState(value);
  };
  const setSnapshotValue = (value: SourceNetworkSettings | undefined) => {
    snapshotRef.current = value;
    setSnapshot(value);
  };

  /** Adopts a server answer after something the person did: the picker and address follow the server. */
  const apply = useCallback((next: SourceNetworkSettings) => {
    setSnapshotValue(next);
    setChoice(sourceNetworkMode(next));
    if (next.defaultProxy) remembered.current = next.defaultProxy;
    setAddressValue(next.defaultProxy || remembered.current);
  }, []);

  useEffect(
    () => () => {
      operation.current?.abort();
      background.current?.abort();
    },
    [],
  );
  useEffect(() => {
    let previous = manager.getSnapshot().error;
    return manager.subscribe(() => {
      const current = manager.getSnapshot().error;
      if (current === previous) return;
      previous = current;
      operation.current?.abort();
      operation.current = undefined;
      background.current?.abort();
      setBusy(false);
      setSnapshotValue(undefined);
      setChoice(undefined);
      setAddressValue('');
      setMessage('');
      setError('');
    });
  }, [manager]);

  const run = useCallback(
    async (request: SourceNetworkSettingsRequest | undefined, done?: string) => {
      if (!manager.networkSettings || operation.current) return;
      background.current?.abort();
      const controller = new AbortController();
      operation.current = controller;
      setBusy(true);
      setError('');
      if (request) setMessage('');
      try {
        const result = await manager.networkSettings(request, controller.signal);
        if (controller.signal.aborted) return;
        apply(result);
        if (done) setMessage(done);
      } catch (cause) {
        if (controller.signal.aborted) return;
        if (
          !request &&
          (errorCode(cause) === 'source_network_unavailable' ||
            (cause instanceof RemoteApiError && cause.status === 404))
        ) {
          setUnsupported(true);
        } else if (!request) {
          setError(errorCode(cause) === VAULT_LOCKED ? VAULT_LOCKED : '연결 설정을 불러오지 못했어요.');
        } else {
          const failure = saveMessage(cause);
          setError(failure.message);
          if (snapshotRef.current) setChoice(sourceNetworkMode(snapshotRef.current));
          if (failure.reload) {
            const fresh = await manager.networkSettings(undefined, controller.signal).catch(() => undefined);
            if (fresh && !controller.signal.aborted) apply(fresh);
          }
        }
      } finally {
        if (operation.current === controller) {
          operation.current = undefined;
          setBusy(false);
        }
      }
    },
    [manager, apply],
  );

  /**
   * Background health: only the snapshot changes, and a refresh still on its way is never cancelled by the next. The picker follows the server only while the person has no
   * unsaved choice or address, so a half-typed proxy survives every refresh.
   */
  const refreshHealth = useCallback(async () => {
    // A slow answer is still worth waiting for; aborting it on every tick would starve the refresh.
    if (!manager.networkSettings || operation.current || background.current) return;
    const controller = new AbortController();
    background.current = controller;
    try {
      const next = await manager.networkSettings(undefined, controller.signal);
      if (controller.signal.aborted || operation.current) return;
      const before = snapshotRef.current;
      const editing =
        before !== undefined &&
        (choiceRef.current !== sourceNetworkMode(before) ||
          addressRef.current.trim() !== (before.defaultProxy || remembered.current));
      setSnapshotValue(next);
      if (!editing) {
        setChoice(sourceNetworkMode(next));
        if (next.defaultProxy) remembered.current = next.defaultProxy;
        setAddressValue(next.defaultProxy || remembered.current);
      }
    } catch {
      // A missed health refresh is retried on the next tick; it never interrupts editing with an error.
    } finally {
      if (background.current === controller) background.current = undefined;
    }
  }, [manager]);

  const load = useCallback(() => run(undefined), [run]);

  /** The saved address to send when the address itself is not what changes; environment defaults stay null. */
  const keptProxy = (current: SourceNetworkSettings) =>
    current.origin === 'environment' ? null : current.defaultProxy;
  /** Older servers have no byedpi switch to send; newer ones get it kept in step with the explicit mode. */
  const byedpiField = (current: SourceNetworkSettings, enabled: boolean) =>
    current.byedpi ? { byedpiEnabled: enabled } : {};

  const select = (mode: SourceNetworkMode) => {
    const current = snapshotRef.current;
    if (!current || busy) return;
    setMessage('');
    setError('');
    setChoice(mode);
    if (mode === sourceNetworkMode(current) && mode !== 'custom') return;
    const modern = current.defaultMode !== undefined;
    if (mode === 'byedpi')
      void run(
        {
          revision: current.revision,
          defaultProxy: keptProxy(current),
          ...(modern ? { defaultMode: 'byedpi' as const } : {}),
          byedpiEnabled: true,
        },
        'ByeDPI로 연결해요. 다음 소스 요청부터 적용돼요.',
      );
    else if (mode === 'direct')
      void run(
        modern
          ? {
              revision: current.revision,
              defaultProxy: keptProxy(current),
              defaultMode: 'direct',
              ...byedpiField(current, false),
            }
          : { revision: current.revision, defaultProxy: '', ...byedpiField(current, false) },
        '직접 연결해요. 다음 소스 요청부터 적용돼요.',
      );
    else if (current.defaultProxy && (modern ? sourceNetworkMode(current) !== 'custom' : current.byedpi?.enabled))
      // A saved address is already there; switching back to it needs no typing.
      void run(
        {
          revision: current.revision,
          defaultProxy: keptProxy(current),
          ...(modern ? { defaultMode: 'custom' as const } : {}),
          ...byedpiField(current, false),
        },
        '저장한 프록시로 연결해요. 다음 소스 요청부터 적용돼요.',
      );
  };

  const saveCustom = () => {
    const current = snapshotRef.current;
    if (!current || busy) return;
    const value = address.trim();
    if (!value) {
      setError('프록시 주소를 입력해 주세요.');
      return;
    }
    void run(
      {
        revision: current.revision,
        defaultProxy: value,
        ...(current.defaultMode !== undefined ? { defaultMode: 'custom' as const } : {}),
        ...byedpiField(current, false),
      },
      '저장했어요. 다음 소스 요청부터 적용돼요.',
    );
  };

  /** The server infers direct or custom from its environment proxy, so no mode is sent. */
  const restoreEnvironment = () => {
    const current = snapshotRef.current;
    if (!current || busy) return;
    void run(
      { revision: current.revision, defaultProxy: null, ...byedpiField(current, false) },
      '서버 기본값으로 되돌렸어요.',
    );
  };

  const byedpi = snapshot?.byedpi;
  const byedpiStalled = Boolean(byedpi?.enabled && !byedpi.running);
  useEffect(() => {
    if (!byedpiStalled || busy) return;
    const timer = globalThis.setInterval(() => void refreshHealth(), BYEDPI_RETRY_POLL_MS);
    return () => globalThis.clearInterval(timer);
  }, [byedpiStalled, busy, refreshHealth]);

  return {
    available: Boolean(manager.networkSettings) && !unsupported,
    target: manager.target,
    snapshot,
    mode: snapshot ? sourceNetworkMode(snapshot) : undefined,
    choice,
    address,
    setAddress: (value: string) => {
      setAddressValue(value);
      setMessage('');
    },
    busy,
    message,
    error,
    byedpiStalled,
    load,
    select,
    saveCustom,
    restoreEnvironment,
  };
}

export type SourceNetworkSettingsModel = ReturnType<typeof useSourceNetworkSettingsModel>;
