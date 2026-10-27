-- Account voice metadata and immutable synthesis identity are separate.
create table tts_voice_library (
  id uuid primary key, user_id text not null references users(id) on delete cascade,
  voice_id text not null, provider_id text not null, provider_voice_id text not null,
  model jsonb not null, metadata jsonb not null, origin text not null,
  design_prompt text, sample bytea, sample_type text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(user_id, voice_id), check(octet_length(sample)<=4194304)
);
create table tts_voice_designs (
  user_id text not null references users(id) on delete cascade, request_id text not null,
  input_hash text not null, status text not null, voice_id uuid references tts_voice_library(id) on delete set null,
  created_at timestamptz not null default now(), primary key(user_id,request_id)
);
create table speaker_voice_bindings (
  user_id text not null references users(id) on delete cascade,
  book_id text not null references library_books(id) on delete cascade,
  analysis_key text not null, speaker_id text not null, name text not null,
  voice_id text not null, model jsonb not null, metadata jsonb not null,
  pinned boolean not null default false, updated_at timestamptz not null default now(),
  primary key(user_id,book_id,analysis_key,speaker_id)
);
create table speaker_voice_decisions (
  audiobook_id uuid not null references saved_audiobooks(id) on delete cascade,
  decision_key text not null, response text, dispatching boolean not null default false,
  rejected boolean not null default false,
  primary key(audiobook_id,decision_key), check(octet_length(response)<=262144)
);
