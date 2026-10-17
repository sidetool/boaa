import { validBind, validCode, validLifecycle } from '../../../../packages/extension-contracts/ui-lifecycle';
import { bindSurfaceKeys } from './surface-keys';
import { GuestSdk } from './sdk';
declare const __BOAA_UI_PARENT_ORIGIN__: string;
// Supplied by the trusted shell build/config, never by a query, fragment or guest message.
const hostOrigin = __BOAA_UI_PARENT_ORIGIN__;
if (parent !== window) {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  let connected = false;
  const timer = setTimeout(() => removeEventListener('message', bind), 5000);
  function bind(event: MessageEvent) {
    if (
      connected ||
      event.source !== parent ||
      event.origin !== hostOrigin ||
      !validBind(event.data) ||
      event.data.nonce !== nonce ||
      event.ports.length !== 1
    )
      return;
    connected = true;
    clearTimeout(timer);
    removeEventListener('message', bind);
    const port = event.ports[0],
      sessionId = event.data.sessionId;
    const send = port.postMessage.bind(port);
    let sdk: GuestSdk | undefined,
      url: string | undefined,
      stopped = false;
    const releaseKeys = bindSurfaceKeys((action) => {
      if (!stopped) send({ wireVersion: 1, kind: 'surface', sessionId, action });
    });
    const releaseUrl = () => {
      if (url) URL.revokeObjectURL(url);
      url = undefined;
    };
    const fail = () => {
      if (stopped) return;
      stopped = true;
      releaseKeys();
      releaseUrl();
      send({ wireVersion: 1, kind: 'lifecycle', sessionId, state: 'failed' });
      void sdk?.stop();
    };
    addEventListener('error', fail);
    addEventListener('unhandledrejection', fail);
    port.onmessageerror = fail;
    port.onmessage = (message) => {
      if (validLifecycle(message.data, sessionId) && message.data.state === 'stop') {
        stopped = true;
        releaseKeys();
        releaseUrl();
        void (sdk?.stop() ?? Promise.resolve()).finally(() => port.close());
        return;
      }
      if (stopped) return;
      if (sdk) {
        sdk.receive(message.data);
        return;
      }
      if (!validCode(message.data, sessionId)) {
        fail();
        return;
      }
      sdk = new GuestSdk(sessionId, message.data.context, send, fail);
      Object.defineProperty(globalThis, 'BoaaPlugin', {
        value: Object.freeze({ register: sdk.register }),
        writable: false,
        configurable: false,
      });
      Object.defineProperty(globalThis, 'MoyaPlugin', Object.getOwnPropertyDescriptor(globalThis, 'BoaaPlugin')!);
      url = URL.createObjectURL(new Blob([message.data.source], { type: 'text/javascript' }));
      const script = document.createElement('script');
      script.src = url;
      script.onload = () => {
        releaseUrl();
        if (!stopped) void sdk!.activate();
      };
      script.onerror = fail;
      document.body.append(script);
    };
    port.start();
    send({ kind: 'bound', wireVersion: 1, sessionId });
  }
  addEventListener('message', bind);
  parent.postMessage({ kind: 'hello', wireVersion: 1, nonce }, hostOrigin);
}
