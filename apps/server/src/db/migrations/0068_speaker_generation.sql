create table speaker_engines (
  id uuid primary key, user_id text not null references users(id) on delete cascade,
  ciphertext text not null, iv text not null, auth_tag text not null, key_version text not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table speaker_generation_preferences (
  book_id text primary key references library_books(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  value jsonb not null, updated_at timestamptz not null default now()
);
alter table saved_audiobooks drop constraint saved_audiobooks_total_items_check;
alter table saved_audiobooks add constraint saved_audiobooks_total_items_check check(total_items >= 0);
alter table saved_audiobooks add column planning_complete boolean not null default true;
create table speaker_generation_runs (
  audiobook_id uuid primary key references saved_audiobooks(id) on delete cascade,
  analysis_key text not null, chapter_ids jsonb not null, next_chapter integer not null default 0,
  stage text not null default 'waiting', ledger jsonb, assignments jsonb not null default '{}'
);
-- Protected server artifacts: no browser cache, no raw model replies in public status.
create table speaker_analysis (
  user_id text not null references users(id) on delete cascade,
  book_id text not null references library_books(id) on delete cascade,
  analysis_key text not null, chapter_id text not null,
  input_hash text not null, checkpoint jsonb, result jsonb,
  bytes bigint not null default 0 check(bytes>=0 and bytes<=16777216),
  model_response text, response_rejected boolean not null default false,
  dispatching boolean not null default false, updated_at timestamptz not null default now(),
  primary key(user_id, book_id, analysis_key, chapter_id)
);
