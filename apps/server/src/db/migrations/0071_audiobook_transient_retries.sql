-- Separate ambiguous audio retries from quota waits and analysis retry limits.
alter table saved_audiobooks add column audio_retry_attempts integer not null default 0
  check (audio_retry_attempts between 0 and 5);
