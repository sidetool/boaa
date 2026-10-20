-- Separate source-preserving, owner-scoped translation storage.
create table translation_settings (
  user_id text primary key references users(id) on delete cascade,
  settings jsonb not null, revision integer not null default 1,
  updated_at timestamptz not null default now()
);
create table translation_credentials (
  user_id text not null references users(id) on delete cascade,
  provider text not null, ciphertext text not null, iv text not null, auth_tag text not null,
  key_version text not null, updated_at timestamptz not null default now(),
  primary key(user_id, provider)
);
create table translation_jobs (
  id text primary key, user_id text not null references users(id) on delete cascade,
  book_id text references library_books(id) on delete cascade,
  content_revision_id text, work_key text not null, chapter_key text not null,
  source_hash text not null, profile_hash text not null,
  settings jsonb not null, input jsonb not null, output jsonb not null default '[]',
  completed integer not null default 0, status text not null default 'queued',
  error_code text, execution_id text, prefetch boolean not null default false,
  input_characters integer not null, charged_day date not null default current_date,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(user_id, work_key, chapter_key, source_hash, profile_hash)
);
create index translation_jobs_recovery on translation_jobs(status, updated_at);
create index translation_jobs_owner_day on translation_jobs(user_id, charged_day);
create table translation_daily_usage (
  user_id text not null references users(id) on delete cascade,
  day date not null default current_date, characters bigint not null default 0,
  primary key(user_id, day)
);
