-- Deployment/account local authority and encrypted credentials; excluded from library backups.
create table plugin_connections (
  id uuid primary key,
  account_id uuid not null references plugin_account_identity(account_id) on delete cascade,
  scope_key text not null,
  headers jsonb not null,
  profile_id uuid not null,
  installation_id uuid not null,
  digest text not null,
  generation bigint not null,
  slot text not null,
  endpoint text not null,
  roles jsonb not null,
  methods jsonb not null,
  auth_header text,
  encrypted_secret text,
  revision uuid not null,
  unique(account_id, profile_id, installation_id, slot)
);
