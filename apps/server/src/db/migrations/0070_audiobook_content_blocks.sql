-- A provider-confirmed policy refusal is distinct from retryable transport/generation failures.
alter table saved_audiobook_items drop constraint saved_audiobook_items_status_check;
alter table saved_audiobook_items add constraint saved_audiobook_items_status_check
  check (status in ('pending','dispatching','ready','blocked','skipped'));
alter table saved_audiobook_items add column block_reason text
  check (block_reason is null or block_reason in ('SAFETY','RECITATION','BLOCKLIST','PROHIBITED_CONTENT','SPII','content_policy_violation','content_filter'));
alter table saved_audiobook_items add constraint saved_audio_block_reason_required
  check ((status in ('blocked','skipped')) = (block_reason is not null));
