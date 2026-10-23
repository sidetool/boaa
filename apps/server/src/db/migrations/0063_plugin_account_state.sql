-- Plugin payloads and private data are account/library owned and served only by authenticated host APIs.
create table plugin_state_versions (
  account_id uuid not null references plugin_account_identity(account_id) on delete cascade,
  library_id uuid not null,
  revision bigint not null default 0 check(revision >= 0),
  floor_revision bigint not null default 0 check(floor_revision >= 0),
  primary key(account_id,library_id)
);
create table plugin_state_rows (
  account_id uuid not null,
  library_id uuid not null,
  store text not null check(store in ('installations','archives','grants','config','kv','usage','preferences')),
  row_key text not null,
  value jsonb,
  metadata jsonb,
  revision bigint not null check(revision > 0),
  primary key(account_id,library_id,store,row_key),
  foreign key(account_id,library_id) references plugin_state_versions(account_id,library_id) on delete cascade
);
create index plugin_state_rows_revision on plugin_state_rows(account_id,library_id,revision);
