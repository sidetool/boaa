-- Independent connection identities: adding a server never replaces a default provider.
-- Endpoint and credentials share the existing server-side authenticated encryption key.
create table tts_connections (
  id uuid primary key,
  user_id text not null references users(id) on delete cascade,
  ciphertext text not null,
  iv text not null,
  auth_tag text not null,
  key_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index tts_connections_owner on tts_connections(user_id, created_at, id);
