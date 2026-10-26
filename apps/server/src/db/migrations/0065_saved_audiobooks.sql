-- User-selected recordings are durable. They are not part of the disposable TTS LRU cache.
create table saved_audiobooks (
  id uuid primary key,
  user_id text not null references users(id) on delete cascade,
  book_id text not null references library_books(id) on delete cascade,
  content_revision text,
  fingerprint text not null,
  title text not null,
  settings jsonb not null,
  estimate jsonb not null,
  status text not null check (status in ('queued','running','pausing','paused','failed','completed','deleting')),
  total_items integer not null check (total_items > 0),
  completed_items integer not null default 0,
  bytes bigint not null default 0,
  playback_index integer not null default 0,
  current_chapter_title text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, fingerprint)
);
create table saved_audiobook_items (
  audiobook_id uuid not null references saved_audiobooks(id) on delete cascade,
  ordinal integer not null,
  chapter_id text not null,
  chapter_title text not null,
  request jsonb not null,
  status text not null default 'pending' check (status in ('pending','dispatching','ready')),
  cache_key text,
  bytes integer not null default 0,
  primary key(audiobook_id, ordinal)
);
create index saved_audiobooks_queue on saved_audiobooks(status, updated_at);
create index saved_audiobook_cache_key on saved_audiobook_items(cache_key) where status='ready';
