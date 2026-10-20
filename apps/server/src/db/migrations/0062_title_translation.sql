-- Reuse the bounded translation queue, credentials, usage accounting and cancellation fence.
alter table translation_jobs add column kind text not null default 'chapter'
  check (kind in ('chapter','titles'));
create table translation_titles (
  user_id text not null references users(id) on delete cascade,
  source_hash text not null,
  profile_hash text not null,
  job_id text not null references translation_jobs(id) on delete cascade,
  primary key(user_id, source_hash, profile_hash)
);
create index translation_titles_job on translation_titles(job_id);
