-- Deployment-local identities are deliberately excluded from hosted library backups.
create table if not exists plugin_deployment_identity (
  singleton_key smallint primary key check (singleton_key = 1),
  server_id uuid not null,
  library_id uuid not null
);
create table if not exists plugin_account_identity (
  user_id text primary key references self_host_accounts(user_id) on delete cascade,
  account_id uuid not null unique
);
