-- Preserve legacy object IDs and keys; refuse ambiguous ownership instead of assigning shared bytes.
alter table book_objects add column user_id text references users(id);
do $$ begin
  if exists (select object_id from library_books where object_id is not null group by object_id having count(distinct user_id)>1) then
    raise exception 'Object is referenced by multiple owners; reconcile before migration';
  end if;
end $$;
update book_objects o set user_id=(select min(b.user_id) from library_books b where b.object_id=o.id);
update book_objects set user_id=(select user_id from self_host_accounts where bootstrap_owner_key=1) where user_id is null;
-- Before account setup, a legacy database may contain exactly one user.
update book_objects set user_id=(select min(id) from users having count(*)=1) where user_id is null;
alter table book_objects alter column user_id set not null;
alter table book_objects drop constraint book_objects_raw_text_hash_key;
alter table book_objects add unique(user_id,raw_text_hash);
alter table upload_sessions add unique(id,user_id);
alter table import_jobs add constraint import_jobs_upload_owner_fk foreign key(upload_id,user_id) references upload_sessions(id,user_id) on delete cascade;
alter table sync_peer_received_events drop constraint sync_peer_received_events_event_id_fkey;
alter table sync_events drop constraint sync_events_id_key;
alter table sync_events add unique(user_id,id);
alter table sync_peer_received_events add foreign key(user_id,event_id) references sync_events(user_id,id) on delete cascade;
alter table book_objects add unique(id,user_id);
alter table library_books add constraint library_book_object_owner_fk foreign key(object_id,user_id) references book_objects(id,user_id) on update cascade;

alter table library_books add unique(id,user_id);
alter table book_assets add constraint book_assets_book_owner_fk foreign key(book_id,user_id) references library_books(id,user_id) on delete cascade on update cascade;
alter table bookmarks add constraint bookmarks_book_owner_fk foreign key(book_id,user_id) references library_books(id,user_id) on delete cascade on update cascade;
alter table highlights add constraint highlights_book_owner_fk foreign key(book_id,user_id) references library_books(id,user_id) on delete cascade on update cascade;
alter table notes add constraint notes_book_owner_fk foreign key(book_id,user_id) references library_books(id,user_id) on delete cascade on update cascade;

alter table reading_session_events add constraint reading_session_events_book_owner_fk foreign key(book_id,user_id) references library_books(id,user_id) on delete cascade on update cascade;
