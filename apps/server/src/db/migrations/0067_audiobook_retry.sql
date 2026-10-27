-- Rate-limited work sleeps durably without holding a runner connection or failing the whole book.
alter table saved_audiobooks add column retry_at timestamptz;
alter table saved_audiobooks add column rate_limit_attempts integer not null default 0;
