The Docker API includes the MIT-licensed [hufrea/ByeDPI](https://github.com/hufrea/byedpi/tree/7efde1b1296eaaa187b70e951894dde17527489c) v0.17.3 source build. `byedpi.Dockerfile` verifies the pinned archive SHA-256 and emits a static binary plus the upstream license, source archive and build recipe. No MOA implementation code is used.

The server image owner can use the artifact as a named build context (`byedpi`) and copy `/usr/local/bin/byedpi` and `/usr/local/share/byedpi` into the API image. Alternatively, include the `byedpi-build` stage in the server build and copy its `/output/` tree. Preserve the MIT license and source pin in the distributed image.

`server.ts` integration:

```ts
const byedpi = createByeDpiProcess();
const sourceNetwork = createSourceNetworkSettings(extensionVault, config.sourceOutboundProxy, byedpi);
await sourceNetwork.initialize();
app.addHook('onClose', async () => sourceNetwork.close());
```

The Docker deployment sets `BYEDPI_BINARY=/usr/local/bin/byedpi`, `BYEDPI_HOST=0.0.0.0`, `BYEDPI_PORT=1080`, and `BYEDPI_PROXY_URL=socks5://api:1080`. Only internal runtime containers should reach port 1080; do not publish it to the host. Without Docker overrides, the process binds and advertises loopback. `BYEDPI_ARGS_JSON` optionally supplies an operator-owned JSON argument array; daemon, bind, transparent and logging options are rejected so process ownership and private request handling remain reliable. The default site-neutral strategy uses the upstream documented disorder/auto/TLS record options. Effectiveness depends on the operator's network.

JS, APK, browser and metadata adapters receive `sourceNetwork.resolve(sourceOptions)`. APK hosts pass `resolveDefaultProxy: () => sourceNetwork.resolve()` to `ApkExtensionHost.open` and Java tools. Request frames include the default; saved direct/custom APK overrides take precedence. Each connection-policy generation has separate worker and response-cache identities. The metadata runner receives the effective URL through an authenticated internal request header and its private provider scope. External Suwayomi servers manage their own network settings.

The Java APK ABI supports HTTP and SOCKS5 proxy endpoints. It rejects HTTPS proxy endpoints (TLS to the proxy) when inherited; direct/custom overrides remain usable. The built-in ByeDPI endpoint always uses SOCKS5.

The settings API preserves the saved `defaultProxy`; `effectiveProxy` reports ByeDPI when enabled. Startup and SOCKS5 negotiation must succeed before an enable write commits. Failed enable returns HTTP 503 (`byedpi_unavailable` or `byedpi_start_failed`) with unchanged settings/revision. A previously enabled process that stops remains enabled with `running: false`, retries automatically and keeps its proxy URL, so requests fail through that transport until recovery. Initial server startup tolerates that degraded state.
