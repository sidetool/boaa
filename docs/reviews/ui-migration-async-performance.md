# UI migration audit: asynchronous work and performance

Reviewed `release/server-beta4` at `ca5145e` on 2026-10-18. Initial read-only implementation review; the implementation and regression results below were added after the review. Reproductions used synthetic source IDs and in-memory loaders, with no production API calls or private extension data.

## Confirmed findings

### AP-1 — P2: cover cancellation releases the queue slot while the underlying download keeps running

**Locations**

- `src/features/discovery/discovery-session.ts:206-228`: the four-request limit wraps the consumer-facing `resolveExternalSourceCover()` promise; any retained URL also bypasses the queue.
- `src/external-sources/session-cover-cache.ts:130-140,195-221`: pending work has its own controller, but consumer cancellation only rejects that consumer's promise. It neither removes the consumer from `waiters` nor aborts the operation after the last consumer leaves. Retained stale URLs return before revalidation finishes.
- `src/extensions/packages/remote-installed-extensions.ts:714-727`: the hosted cover POST receives the cache's shared operation signal, rather than the card's signal.
- `src/features/discovery/useDiscoveryCover.ts:62-87`: cards abort their consumer signal when they leave the observed viewport or unmount.

**Trigger and reproduction**

Open a cold source catalog on a slow connection, scroll through several groups of covers before they finish, or move between discovery and another screen. A separate trigger is reopening a catalog whose retained covers have expired their freshness period.

An in-memory composition of the real `DiscoverySession` and `SessionCoverCache` was exercised through a registry implementing the same cache-backed cover resolution contract as the hosted registry. Each loader waited on a deferred promise so its actual operation signal could be inspected. Three batches of four distinct covers were requested; each batch's four card controllers were aborted before the next batch began:

| Observation                               | Actual live loader operations |
| ----------------------------------------- | ----------------------------: |
| First four cards                          |                             4 |
| First cards aborted, next four requested  |                             8 |
| Second cards aborted, next four requested |                            12 |
| All twelve card consumers aborted         |                            12 |

A second reproduction first seeded twelve covers, advanced `Date.now()` by 31 days, and requested them through the same session. All twelve retained URLs returned immediately, and **twelve simultaneous revalidation loaders** started. The current default freshness period is 30 days; retention is 365 days.

**Expected / actual**

Expected: shared requests survive one consumer leaving if another still needs them; abandoned work does not multiply the actual I/O concurrency beyond its configured limit. Cached display remains immediate while revalidation observes a real work limit.

Actual: card cancellation frees a slot without aborting the loader. New visible cards use the freed slots while old HTTP requests remain live. Stale-memory hits launch revalidation outside the four-slot queue altogether. These extra requests can compete with currently visible covers; the amount of user-visible delay and server-side work was not measured against a live host.

**Evidence certainty:** high for operation lifetime and the concurrency violation: both were reproduced using the actual classes. The hosted HTTP signal wiring is directly verified in source. No claim is made that a specific production slowdown was caused solely by this defect.

**Coherent minimal fix**

Give actual cache fill/revalidation operations explicit shared ownership and apply the concurrency permit to those operations, not to promises returned early or rejected for one consumer. Remove cancelled consumers and abort an unfinished fill only when its last interested consumer leaves. A retained-URL revalidation must retain an explicit owner until the relevant consumer leaves; returning the URL must not make the background task unowned. Clear/dispose/invalidate must release listeners, pending queue entries and operation permits safely, with stale generations unable to publish a blob.

Preserve existing successful cache semantics: one network load per key, immediate fresh and retained URL delivery, stable URLs for identical bytes, pinned visible URLs, persistent blobs after successful completion, and one remaining consumer keeping a shared request alive. A large source-registry or UI rewrite is unnecessary.

**Regression validation**

1. Two consumers share one operation: aborting one leaves the operation live; aborting the last reaches the loader signal.
2. Reproduce three viewport batches and verify actual simultaneously running loaders never exceed the chosen limit. Count loaders, not consumer promises.
3. Seed more stale covers than the limit: old URLs are immediate, but refresh loaders remain bounded.
4. Cancel queued requests, invalidate a source, and dispose a session/cache during fills; all promises settle, permits recover, and obsolete results create no URL or cache entry.
5. Preserve existing shared ownership, persistent-cache, identical-byte, URL pinning/eviction and cross-navigation reuse tests. Verify hosted `requestBlob` receives the abort after the last owner disappears.

### AP-2 — P2: a discovery pagination error hides both recovery and pagination

**Locations**

- `src/ui-next/discovery/UiNextDiscoveryScreen.tsx:184-190`: error text and retry exist only when `!view.data.hasPage`.
- `src/ui-next/discovery/UiNextDiscoveryScreen.tsx:205-210`: the load-more control disappears whenever an error exists.
- `src/features/discovery/useDiscoveryPages.ts:59-83,100-112`: failed subsequent pages preserve earlier pages and set the error; stale cached responses also set an error while retaining pages.

**Trigger and reproduction**

1. Open a dedicated source catalog, or expand a discovery row.
2. Successfully load a first page with a next cursor.
3. Choose **더 불러오기** and fail the second request, for example with a temporary network error.

The real `useDiscoveryPages` hook was mounted with `react-test-renderer`, one synthetic first page and a rejecting second page. Its settled snapshot was:

```text
hasPage: true
more: true
error: "fixture offline"
busy: false
items: [first-page item]
```

Both UI render conditions evaluate to false: `error && !hasPage`, and `more && !error`. The same condition hides the warning and recovery after a stale cached result is returned.

**Expected / actual**

Expected: preserve the usable first page, explain that the next page failed, and offer a local retry. A cached fallback should identify itself as stale when the hook reports it.

Actual: the user retains the first-page covers but loses the pagination button without an explanation or local recovery. The screen's global refresh is still available, so this is a silent local dead end rather than a permanently unrecoverable screen.

**Evidence certainty:** high. The real hook's error state was reproduced, and the UI conditions are directly verified. Existing UI tests cover initial-page failure and successful pagination but do not enforce recovery with `hasPage === true`.

**Coherent minimal fix**

Render the existing error and retry affordance when `data.error` exists regardless of whether a page is already present, positioning it beside/below the retained results for subsequent-page errors. Retain the existing pages and desired page depth; use the hook's existing `retry()` command. Avoid changing source identities, cache policy or pagination ownership for this presentation defect.

**Regression validation**

1. Successful first page, failed second page: first-page items stay visible and error/retry are visible.
2. Retry succeeds: subsequent items append without duplicates and normal pagination returns.
3. Stale cached page: its warning and retry remain visible even with items.
4. Initial-page error and successful empty results retain their current behavior.

## Checked behavior and limits

- The earlier server-management polling correction is present: background refresh does not abort an existing GET, inactive hidden pages skip idle work, and returning to visibility refreshes. `ServerPage.test.tsx` passes.
- ByeDPI refresh separates background status from the unsaved proxy draft and refuses to start a second background request while one is active. Existing slow-refresh/draft-preservation coverage passes.
- `7014c93` contains the mobile extension-row CSS correction; it was not reported as missing. Extension-panel tests pass. This review did not repeat a mobile screenshot comparison.
- Global source search uses independent abort controllers and generation/connection checks. Its focused tests pass. Discovery list caching deliberately uses an app-session-owned queue; continued shared list work was not automatically classified as a defect merely because a view unmounted.
- Successful cover URL pinning, identical-byte reuse, invalidation and cache-clear coverage passes. AP-1 concerns unfinished work ownership and actual request limits, not a demonstrated premature-revocation defect.
- Library renders all adapter works without virtualization. This is visible in source and acknowledged in `docs/architecture/modular-reader-core.md`; no new synthetic library timing or whole-app interaction benchmark was performed here, so no measured performance-regression claim is made.
- Reader-content internals, download identity, recent-read projection and shelf semantics are outside this audit's focused findings. No browser accessibility conformance or live-backend cancellation test was run.

## Validation performed

All focused tests passed: **8 files, 114 tests**.

```sh
node_modules/.bin/vitest run \
  src/features/discovery/discovery-session.test.ts \
  src/external-sources/session-cover-cache.test.ts \
  src/extensions/packages/remote-installed-extensions.test.ts \
  src/ui-next/discovery/UiNextDiscoveryScreen.test.tsx \
  src/ui-next/search/source-search.test.ts \
  src/ui-next/settings/SourceNetworkSettings.test.tsx \
  --maxWorkers=2

node_modules/.bin/vitest run \
  src/ui-next/settings/pages/ServerPage.test.tsx \
  src/ui-next/settings/UiNextExtensionsPanel.test.tsx \
  --maxWorkers=2
```

Three additional in-memory reproductions were executed through the existing `tsx` loader: abandoned cold cover batches, stale cover revalidation concurrency, and the actual pagination hook's failure snapshot. They made no repository implementation changes.

## Implementation and regression validation — AP-1/AP-2

Implemented on the same release worktree without publishing, deploying or using production/private data.

- **AP-1:** `SessionCoverCache` now owns the four-operation I/O limit for both cold loads and retained-cover revalidation. Consumer cancellation removes that owner; the last owner aborts the shared loader and removes abandoned queued work. One remaining owner keeps the shared request alive. Cached URLs still return immediately, with ownership retained for the background refresh. Source invalidation, cache clear and session disposal reject waiting consumers promptly and prevent obsolete results from publishing. A loader that ignores abort retains its permit until it actually settles, including after invalidation/clear; cancellation cannot multiply actual I/O. Completed owners' abort listeners are removed. Existing identical-byte URL reuse, persistent storage and URL pins/eviction remain covered.
- `DiscoverySession` retains its four-consumer admission queue for generic registries and its cold-request timeout. Queued admission now observes cancellation/disposal. This session queue is distinct from the cache's authoritative shared loader limit; retained URLs bypass admission but their revalidation still observes the cache limit.
- **AP-2:** The source results screen renders the existing error/retry below retained results regardless of `hasPage`. The existing hook retry retains requested page depth. Added screen cases for next-page failure and stale fallback plus a real-hook test for failed second-page retry, retained first-page items, deduplication and restored pagination.
- Hosted registry regression coverage verifies that only the last cover consumer aborts the POST signal. Generation invalidation now rejects promptly with `AbortError`; the previous test expected a generation error only after the late response arrived.

**Failure before / success after:** replayed the new targeted tests against the original `ca5145e` versions of the three changed implementation files, restoring the working implementations automatically afterward. All four targeted assertions failed on baseline: the second abandoned viewport batch had **8 actual live loaders instead of 4**; twelve stale URLs started **12 revalidation loaders instead of 4**; both retained-result error variants had no status/retry element. All four pass with the implementation.

Final focused regression run: **12 files, 120 tests passed**.

```sh
node_modules/.bin/vitest run \
  src/external-sources/session-cover-ownership.test.ts \
  src/external-sources/session-cover-cache.test.ts \
  src/external-sources/missing-cover-cache.test.ts \
  src/external-sources/persistent-cover-cache.test.ts \
  src/features/discovery/discovery-session.test.ts \
  src/features/discovery/discovery-swr.test.tsx \
  src/features/discovery/useDiscoveryCover.test.ts \
  src/ui-next/discovery/UiNextDiscoveryScreen.test.tsx \
  src/extensions/packages/remote-installed-extensions.test.ts \
  src/features/external-sources/use-library-work-covers.test.tsx \
  src/features/external-sources/library-cover-resolver.test.ts \
  src/features/external-sources/source-cover.test.ts \
  --maxWorkers=2
```

The new ownership tests count actual loader start/completion, deliberately ignore cancellation, exercise multiple sessions and consumers, three viewport batches, twelve stale covers, queued cancellation, invalidate/clear/dispose and permit recovery. These are in-memory tests, not live-server throughput or browser timing measurements. A non-cooperative loader that never settles continues occupying its permit after timeout: releasing it earlier would recreate the actual-I/O limit violation. Real transport cancellation/settlement remains the transport's responsibility. No production browser/backend run was needed for these state and ownership fixes. The parent integration pass owns final repository-wide typechecking; an interim web typecheck reported only concurrently edited lifecycle-test optional calls, outside these changes.
