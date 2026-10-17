# UI migration audit: work identity and lifecycle

Reviewed `release/server-beta4` at `ca5145e` on 2026-10-18. This is a read-only implementation audit; only this review and temporary synthetic probes were written. No production data, extension code, commits, or deployments were changed.

Two **P2 defects are confirmed**. No P1 was established. The reported symptom needs the exact action and screen: deleting downloaded episodes is intentionally different from moving a library work to trash. A normal single-book trash operation currently hides its source library projection correctly. Permanent deletion and a separate asynchronous trash race do have reproducible defects.

## Identity and intended behavior

The application has a logical source work represented by `(connectorId, accountConnectionId, collectionRemoteId)`, an optional durable subscription carrying its library metadata, and one or more links from source episodes to `Novel.id`. Source streaming history/preferences are separate again. There is no single persisted record that owns every lifecycle transition.

| Action/state                           | Current intended contract and implementation                                                                                                                                                                                                                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Stream without saving episodes         | Does not create a downloaded `Novel` or source file. A subscription can still be created automatically for library continuity; see `use-stream-library-continuity.ts:21` and `recover-stream-library.ts:13`. Thus a streaming library card is not a second downloaded file.                                                                |
| Add work to library                    | Saves source identity, metadata, and release baseline without downloading bodies. The first download should take over the same card; documented in `docs/architecture/external-library-sources.md:290`.                                                                                                                                    |
| Download episodes                      | Keeps source identity and associates the imported book through links. `use-source-library-links.ts:27` projects the active local book ID; `BookWorkspaceScreens.tsx:170` shows only unresolved subscriptions as separate remote cards.                                                                                                     |
| Delete downloaded episodes             | Intentionally retains book identity and links. The confirmation explicitly says the work stays in the library (`useExternalSourceController.ts:1366`); `remove-downloaded-releases.ts:6` changes the source revision and cleans removed assets. This is not whole-work trash.                                                              |
| Trash downloaded work                  | `BookWorkspaceScreens.tsx:432` calls the novel lifecycle operation. Source links/subscription remain for restoration, but `use-source-library-links.ts:18` hides the subscription when all its associated books are trashed. Both the main library and Source Hub's added-works list consume this projection (`useSourceHubModel.ts:134`). |
| Trash stream-only work                 | Sets subscription `deletedAt`, preserving cover and history. Main library filters place it in trash. Restore removes that marker.                                                                                                                                                                                                          |
| Purge stream-only work                 | `changeLibraryTrash` invokes `clearTrashedWorkHistory` before deleting the subscription (`useExternalSourceController.ts:3462`, `3493`). The history helper writes unread tombstones so prior visits cannot recreate it.                                                                                                                   |
| Purge downloaded work                  | Deletes the book and its physical/reader data, then reconciliation removes missing links and the last associated subscription. This path fails to retire source stream history; finding WL-1 below.                                                                                                                                        |
| Browse the upstream source after trash | Upstream catalog entries remain available; trash does not delete a remote work. Stream availability there is not proof that the library trash operation failed. Re-import into an existing trashed downloaded book is rejected with a restore/purge instruction (`useExternalSourceController.ts:1890`, `2506`).                           |

Legacy multiple-book associations are deliberately not automatically merged: `useExternalSourceController.ts:1877` rejects a serial append when several local targets exist. If one associated book remains active, hiding the whole source identity or clearing its history would be incorrect. Account/source identity boundaries and active pending imports must remain protected by any fix.

## WL-1 — P2: purging a downloaded-and-streamed work immediately recreates its active library card

**Locations:** `src/external-sources/local-state.ts:494` (especially `497`, `517–521`), `src/features/external-sources/source-library-snapshot.ts:62–75`, `src/features/external-sources/recover-stream-library.ts:19–29`, and `src/features/book-workspace/book-workspace-controller.ts:647–673`.

**Trigger / reproduction:**

1. A synthetic source work has a subscription, a completed link to its downloaded book, and a stream visit with `readingMode: 'stream'` and `lastReadAt`.
2. Trash its downloaded book. The authoritative catalog still contains that book with `deletedAt`, so reconciliation preserves its link and subscription. The source library projection is hidden, as intended.
3. Permanently delete the book, either individually or through empty trash. On the next complete catalog refresh that book is absent.
4. `removeMissingBookLinks` removes the completed link and last associated subscription. Its transaction contains only `links` and `subscriptions`; the stream visit survives.
5. In the **same** `loadSourceLibrary` call, `recoverStreamLibrary` sees an eligible visit with no subscription and persists a new active subscription.

**Expected:** successful whole-work permanent deletion must not be undone by an older source visit. A later explicit user action may add/read the work again.

**Actual:** the source work returns as an active streaming card, with the old last-read visit. The downloaded book remains deleted. When cached source metadata is absent, the recreated record also loses the old subscription's cover. This is a consequence of resurrection, not a repeat of the detached-save cover bug fixed in `7014c93`.

**Evidence / scope:** a probe using the real `ExternalSourceLocalStateStore` with fake IndexedDB and the complete `loadSourceLibrary` pipeline passed assertions that: (a) trash preserves the link/subscription, (b) purge reconciliation empties links, (c) the returned and persisted subscription nevertheless exists without `deletedAt`, and (d) the prior visit survives while the prior cover disappears. Applicable to local and hosted clients because the recovery pipeline is client-side. Requires qualifying stream history; a download-only work without such history does not reproduce it. Other remaining book links prevent subscription deletion and must continue to do so.

**Why existing tests miss it:** `missing-book-links.test.ts` and `source-book-lifecycle.integration.test.ts` end their checks at `reconcilePendingExternalSourceLinks`; `stream-library-continuity.test.tsx` separately verifies historical stream recovery. None combines permanent purge, a qualifying visit, and the full snapshot loader.

**Smallest coherent remedy:** coordinate source-history retirement with the existing authoritative last-link cleanup boundary. Reuse the existing unread/timestamp tombstone semantics rather than adding broad polling or replacing the identity model. Only retire a source work when the CAS-protected cleanup actually removes its final completed association and no other book or pending import remains. Make recovery suppression durable before removing the last membership record, so a crash or cleanup failure cannot recreate it on the following load. Clear the corresponding stream position/visit journal/reading time through the existing history machinery. Do not eagerly erase every subscription/history entry merely because one local book is purged, and do not change episode download removal semantics.

**Regression coverage:** full `loadSourceLibrary` tests for individual purge and empty trash with stream history; reload and stale pending-visit replay; history-cleanup failure/retry; trash→restore retaining metadata/history; a second linked active book and pending import retaining the work; subscription-only works remaining untouched; explicit later re-add/read being allowed. Extend the existing hosted lifecycle test through the snapshot layer rather than checking only missing-link reconciliation.

## WL-2 — P2: an older library snapshot can undo single-work trash or restore in the UI

**Locations:** `src/features/external-sources/useExternalSourceController.ts:3482–3497`; stale snapshot application at `420–429` and `463–472`. Compare existing generation invalidation for batch trash at `3532` and metadata edits at `4168`.

**Trigger / reproduction:**

1. Start a library refresh for a stream-only subscription and allow it to capture the active subscription array.
2. Delay its release-preference read, which shares `Promise.all` with the subscription read in `source-library-snapshot.ts:66`.
3. Call the ordinary single-work trash action. It saves `deletedAt`, publishes the trashed subscription in memory, and reports success.
4. Resolve the older read. The load generation still matches, so the callback replaces subscriptions with its pre-trash snapshot.

**Expected:** a snapshot that predates a successful local lifecycle mutation must not overwrite that mutation's visible state.

**Actual:** persisted data remains trashed, but `controller.libraryWorks` becomes active again until another authoritative refresh. The reverse stale-state overwrite is also possible for restore through the same unfenced function; the isolated probe specifically reproduced trash.

**Evidence / scope:** a controller-level synthetic probe used the existing `createHarness` fixture, delayed `state.listReleasePreferences`, called `refreshLibrary(1)` then `removeLibraryWork`, and verified both the transient correct trashed card and subsequent incorrect active card while `state.listSubscriptions` still retained `deletedAt`. No network failure, invalid data, or concurrent browser tab is required. The asynchronous window is narrow; it is not an always-on failure of trash.

**Smallest coherent remedy:** use the existing `libraryLoadGeneration` fence when publishing successful single-work trash/restore mutations, as batch trash already does. Factor a shared subscription mutation publisher if useful, but do not introduce another lifecycle scheduler. Preserve failure handling so a rejected write does not falsely report or persist a completed mutation.

**Regression coverage:** hold an older snapshot across single trash and restore; resolve it after the mutation and assert both durable and projected states remain current. Cover both the effect-driven loader and `refreshLocalProjection`, plus failed mutation and the existing batch path. Purge already starts a new projection load, so do not assume the same reproduction automatically applies to purge.

## Existing safety boundaries and remaining uncertainty

- Local book lifecycle uses transactions, expected metadata revisions, and lifecycle sync events (`src/storage/library-catalog-store.ts:56`, `95`, `134`). Hosted catalog lifecycle routes constrain mutations to the current owner, use optional expected revisions, require trash before purge, and enqueue physical object cleanup (`apps/server/src/routes/books/catalog-routes.ts`). The findings do not demonstrate server resurrection or physical-file retention after a successful purge.
- Source cleanup reads links before an authoritative catalog including trash. It compares the link snapshot before removal and preserves pending imports/other links. `remote-book-transport.ts:42` requires the hosted API to confirm `includesTrash`; a failed or active-only catalog must not be treated as proof of deletion.
- Subscription refresh cancels source requests and re-reads subscription state before publishing refreshed metadata (`use-source-subscription-refresh.ts:96`). This is useful protection, but it does not fence the separate full library snapshot in WL-2.
- Source-derived cover/progress continuity uses the same source identity independently of downloaded availability. The prior `7014c93` cover persistence fix was inspected and is not duplicated as a finding. Progress filtering/sorting belongs to the separate library-semantics review.
- No live user library, source-specific identifiers, browser recording of the original report, or production extension was inspected. The original “trash leaves streaming” report cannot be assigned to one exact path without that evidence. It is consistent with WL-2, whereas a deliberate episode-download deletion or an upstream catalog entry is expected behavior.

## Validation and reproducible probes

Focused existing tests: **5 files, 15 tests passed** (`source-library-trash`, `stream-library-continuity`, `missing-book-links`, `use-library-work-actions`, `workspace-screen-support`). Isolated synthetic probes: **2 files, 3 tests passed**. Their assertions intentionally confirm current faulty outcomes; implementation regressions should invert those assertions.

Temporary probe sources retained for the implementation reviewer, outside tracked source:

- `.tmp/audit-work-lifecycle.test.ts`: complete snapshot resurrection and correct plain-trash projection.
- `.tmp/audit-controller-lifecycle.test.tsx`: standalone copy of the existing synthetic controller harness plus the deferred snapshot reproduction.
- `.tmp/audit-work-lifecycle.config.ts`: isolated Vitest configuration.

Run: `node_modules/.bin/vitest run --config .tmp/audit-work-lifecycle.config.ts --maxWorkers=2`.

Hosted source lifecycle integration: **1 file, 2 tests passed** (`apps/server/src/db/source-book-lifecycle.integration.test.ts`), with all external test-database URL variables removed so the database was owned by the integration harness. This validates the existing server trash/restore/purge boundary; that test does not cover the full client recovery pipeline in WL-1.

## Resolution (2026-10-18)

WL-1 and WL-2 are implemented in the beta worktree; no deployment or publication was performed.

- WL-1: the existing last-link compare-and-swap transaction now commits unread timestamp tombstones together with removal of the final association and subscription. It includes known releases, stored preferences, and the scoped pending-visit checkpoint. Another surviving link (including a pending import) prevents retirement; unsuccessful or incomplete catalog reads retain the existing boundary. Subscription-only works are untouched.
- Device position/session cleanup cannot participate in the same IndexedDB transaction. The existing `associationPurgeIntents` store therefore holds a narrow durable cleanup receipt containing the scope, work, release IDs, and retirement timestamp. The existing snapshot loader drains these receipts; there is no new scheduler. Retry never changes subscription membership or writes new unread markers. It acknowledges superseded journal visits using existing timestamp rules and clears only positions/sessions at the recorded cutoff, preserving later explicit visits and re-adds. Receipt acknowledgement compares the stored record before deleting it, so an older cleanup cannot acknowledge a newer purge.
- WL-2: successful single-work trash/restore/purge publication advances the existing library-load generation. Rejected writes do not advance it. Both effect-driven refresh and explicit projection retry remain guarded by that generation.

Durable regressions replace the temporary faulty-outcome probes. Before implementation, the new full snapshot purge test and single trash/restore tests all failed (3 failures). After implementation, the focused lifecycle/history/controller suite passed: **6 files, 159 tests**. This includes both stale-loader paths, stale journal replay, interrupted cleanup with later explicit reading/re-add and a new link, second active/pending associations, failed catalog reads, account isolation, and the existing trash/restore and CAS tests.

The hosted lifecycle integration now also traverses `loadSourceLibrary` with qualifying stream history for both single purge and empty trash. The implementation worker's initial run skipped because its harness was unavailable; the parent subsequently reran the updated tests with all external database URLs unset and an owned PostgreSQL instance: **1 file, 2 tests passed (28.70 seconds)**. No production database was used. Browser multi-tab timing and live extension data were not exercised.

Web typechecking identified optional test controller callbacks; the new regression calls were corrected. The same run also reported unrelated extension-package test ID typing errors, left to the owning workstream. The parent will run the integrated typecheck after all edits stabilize. Final targeted purge/missing-link rerun: **2 files, 12 tests passed**; `git diff --check` passed.

### Independent review follow-up

The final independent review found two remaining WL-1 interleavings; both were reproduced as failing real-store tests before correction and folded into `purged-source-library.test.ts`.

1. Journal recovery had captured preferences before a concurrent purge, then blindly replayed the old target visit after saving an unrelated visit. `replaySourceStreamVisit` now compares the current stored read/reset timestamps and writes within one IndexedDB transaction. It returns the authoritative current or saved record, and recovery uses that returned record in its projected preference map. Failed atomic comparisons keep the checkpoint and reject the load rather than publishing uncertain stale history. Ordinary manual preference writes remain unchanged. The regression checks both durable unread state and the returned recovery map, followed by the full snapshot's absence of resurrection.
2. A purge receipt could survive account hydration and incorrectly replay the prior account's journal through the current account's state. Receipts are now keyed by scope as well as work, and the snapshot drains only its current settings scope. Device cleanup directly acknowledges matching old work visits up to the receipt cutoff; it never calls journal replay through shared state. The regression hydrates another account, verifies its preferences/library remain empty, then switches back and verifies cleanup without resurrection.

Post-fix validation: **6 files, 164 tests passed** after the atomic-replay fix; after the scoped-cleanup fix, the focused purge/journal/history suite passed **3 files, 20 tests**. The associated server type dependency was corrected by importing `ToastTone` from its defining `.ts` module rather than the JSX host; server typechecking passed after that correction. `git diff --check` passed. These results supersede the initial implementation's claim that existing replay timestamp checks alone covered concurrent purge and interrupted account-switch cases.
