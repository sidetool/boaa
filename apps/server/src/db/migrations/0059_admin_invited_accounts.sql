alter table users alter column email drop not null;
alter table self_host_accounts drop constraint self_host_accounts_pkey;
alter table self_host_accounts rename column singleton_key to bootstrap_owner_key;
alter table self_host_accounts alter column bootstrap_owner_key drop not null;
alter table self_host_accounts alter column bootstrap_owner_key drop default;
alter table self_host_accounts add primary key (user_id);
alter table self_host_accounts add unique (bootstrap_owner_key);
alter table self_host_accounts add column role text not null default 'member' check (role in ('admin','member'));
alter table self_host_accounts add column status text not null default 'active' check (status in ('invited','active','disabled'));
alter table self_host_accounts add column auth_version integer not null default 1 check (auth_version > 0);
update self_host_accounts set role = 'admin' where bootstrap_owner_key = 1;
alter table self_host_accounts alter column password_scheme drop not null;
alter table self_host_accounts alter column password_salt drop not null;
alter table self_host_accounts alter column password_digest drop not null;
alter table self_host_accounts add constraint self_host_credentials_complete check ((password_scheme is null and password_salt is null and password_digest is null and status <> 'active') or (password_scheme is not null and password_salt is not null and password_digest is not null));
alter table self_host_accounts add constraint self_host_owner_protected check (bootstrap_owner_key is null or (role = 'admin' and status = 'active'));
alter table self_host_sessions add column auth_version integer not null default 1;
alter table self_host_sessions add column session_context text not null default gen_random_uuid()::text unique;
create table self_host_account_tokens (
 token_hash text primary key,
 user_id text not null references self_host_accounts(user_id) on delete cascade,
 purpose text not null check (purpose in ('invite','password-reset')),
 creator_user_id text not null references users(id),
 created_at timestamptz not null default now(), expires_at timestamptz not null,
 consumed_at timestamptz, revoked_at timestamptz
);
create index self_host_account_tokens_user_idx on self_host_account_tokens(user_id, purpose);
