-- Rebuildable plugin data is deliberately separate from account settings/state CAS.
create table plugin_cache_entries (
  account_id uuid not null references plugin_account_identity(account_id) on delete cascade,
  library_id uuid not null,
  installation_id uuid not null,
  authority text not null,
  kind text not null check(kind in ('home','data','image')),
  cache_key text not null,
  value jsonb not null,
  bytes integer not null check(bytes > 0),
  saved_at bigint not null,
  fresh_until bigint not null,
  expires_at bigint not null,
  primary key(account_id,library_id,installation_id,kind,cache_key)
);
create index plugin_cache_expiry on plugin_cache_entries(expires_at);
