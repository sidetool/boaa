-- Applied migration files are immutable. Upgrade host-owned JSON fields without
-- changing user text, source identities, archive bytes or persistent ID inputs.
create function pg_temp.boaa_brand_json(value jsonb) returns jsonb
language plpgsql immutable as $$
declare
  result jsonb;
  field text;
  child jsonb;
  canonical text;
begin
  if jsonb_typeof(value) = 'array' then
    select coalesce(jsonb_agg(pg_temp.boaa_brand_json(entry) order by ordinal), '[]'::jsonb)
      into result from jsonb_array_elements(value) with ordinality as items(entry, ordinal);
    return result;
  end if;
  if jsonb_typeof(value) <> 'object' then return value; end if;
  result := '{}'::jsonb;
  for field, child in select * from jsonb_each(value) loop
    canonical := field;
    if field <> '__moya_global_comic_profile__' and field !~ '^(moya\.(external|local)\.|moya\.ai\.tts\.book-preparation|moya\.ai\.tts\.detailed\.speaker-preparation$|moya\.ai\.analysis\.character-bundle$)' then
      canonical := regexp_replace(canonical, '^_(moya|noveldesk)(?=[A-Z_.:])', '_boaa');
      canonical := regexp_replace(canonical, '^__(moya|noveldesk)_', '__boaa_');
      canonical := regexp_replace(canonical, '^(moya|noveldesk)\.', 'boaa.');
      canonical := regexp_replace(canonical, '^(moya|noveldesk)(Api|Series)$', 'boaa\2');
    end if;
    if canonical <> field and value ? canonical then continue; end if;
    if field = 'packageFormat' and child = '"moya.extension.package"'::jsonb then child := '"boaa.extension.package"'; end if;
    if field = 'format' and child = '"moya.extension.repository"'::jsonb then child := '"boaa.extension.repository"'; end if;
    if field = 'kind' and child = '"moya-js"'::jsonb then child := '"boaa-js"'; end if;
    if field in ('id', 'extensionId', 'definitionId', 'workflowDefinitionId', 'providerId')
       and jsonb_typeof(child) = 'string'
       and (child #>> '{}') !~ '^(moya\.(external|local)\.|moya\.ai\.tts\.book-preparation|moya\.ai\.tts\.detailed\.speaker-preparation$|moya\.ai\.analysis\.character-bundle$)' then
      child := to_jsonb(regexp_replace(child #>> '{}', '^(moya|noveldesk)\.', 'boaa.'));
    end if;
    if field = 'settings' and value ? 'manifest' and value ? 'digest' then
      result := result || jsonb_build_object(canonical, child);
    else
      result := result || jsonb_build_object(canonical, pg_temp.boaa_brand_json(child));
    end if;
  end loop;
  return result;
end;
$$;

update reader_settings set settings = pg_temp.boaa_brand_json(settings)
 where settings is distinct from pg_temp.boaa_brand_json(settings);
update extension_packages set metadata = pg_temp.boaa_brand_json(metadata)
 where metadata is distinct from pg_temp.boaa_brand_json(metadata);
update extension_repositories set metadata = pg_temp.boaa_brand_json(metadata)
 where metadata is distinct from pg_temp.boaa_brand_json(metadata);
drop function pg_temp.boaa_brand_json(jsonb);
