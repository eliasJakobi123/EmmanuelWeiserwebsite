-- Nach migration_publish_supabase_rpc.sql ausführen.
-- Ergänzt die Forschungsbereiche und ordnet alle bestehenden Arbeiten
-- rückwärtskompatibel der historischen Forschung zu.

alter table public.site_published_works
  add column if not exists category text;

update public.site_published_works
set category = 'historische-forschung'
where category is null
   or category not in ('historische-forschung', 'religionsphilosophie');

alter table public.site_published_works
  alter column category set default 'historische-forschung',
  alter column category set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'site_published_works_category_check'
      and conrelid = 'public.site_published_works'::regclass
  ) then
    alter table public.site_published_works
      add constraint site_published_works_category_check
      check (category in ('historische-forschung', 'religionsphilosophie'));
  end if;
end
$$;

create index if not exists idx_site_published_works_category_created
  on public.site_published_works (category, created_at desc);

drop function if exists public.ew_publish_create(text, text, text, text, text);
drop function if exists public.ew_publish_create(text, text, text, text, text, text);

create function public.ew_publish_create(
  p_pin text,
  p_title text,
  p_teaser text,
  p_body_text text,
  p_date_label text,
  p_category text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_expected text;
  v_actual text;
  v_id uuid;
  v_category text := coalesce(nullif(trim(p_category), ''), 'historische-forschung');
begin
  select s.pin_sha256_hex into v_expected
  from public._ew_publish_secret s
  where s.id = 1;

  v_actual := encode(extensions.digest(convert_to(trim(p_pin), 'UTF8'), 'sha256'), 'hex');
  if v_actual is distinct from v_expected then
    raise exception 'invalid pin';
  end if;
  if length(trim(p_title)) = 0 or length(trim(p_teaser)) = 0 then
    raise exception 'title and teaser required';
  end if;
  if v_category not in ('historische-forschung', 'religionsphilosophie') then
    raise exception 'invalid category';
  end if;

  insert into public.site_published_works (title, teaser, body_text, date_label, category)
  values (
    trim(p_title),
    trim(p_teaser),
    coalesce(trim(p_body_text), ''),
    nullif(trim(p_date_label), ''),
    v_category
  )
  returning id into v_id;

  return v_id;
end;
$$;

drop function if exists public.ew_publish_update_meta(text, uuid, text, text, text, text);
drop function if exists public.ew_publish_update_meta(text, uuid, text, text, text, text, text);

create function public.ew_publish_update_meta(
  p_pin text,
  p_id uuid,
  p_title text,
  p_teaser text,
  p_body_text text,
  p_date_label text,
  p_category text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_expected text;
  v_actual text;
  v_ok uuid;
  v_category text := coalesce(nullif(trim(p_category), ''), 'historische-forschung');
begin
  select s.pin_sha256_hex into v_expected
  from public._ew_publish_secret s
  where s.id = 1;

  v_actual := encode(extensions.digest(convert_to(trim(p_pin), 'UTF8'), 'sha256'), 'hex');
  if v_actual is distinct from v_expected then
    raise exception 'invalid pin';
  end if;
  if length(trim(p_title)) = 0 or length(trim(p_teaser)) = 0 then
    raise exception 'title and teaser required';
  end if;
  if v_category not in ('historische-forschung', 'religionsphilosophie') then
    raise exception 'invalid category';
  end if;

  update public.site_published_works
  set
    title = trim(p_title),
    teaser = trim(p_teaser),
    body_text = coalesce(trim(p_body_text), ''),
    date_label = nullif(trim(p_date_label), ''),
    category = v_category,
    updated_at = now()
  where id = p_id
  returning id into v_ok;

  if v_ok is null then
    raise exception 'update failed: not found';
  end if;
end;
$$;

grant execute on function public.ew_publish_create(text, text, text, text, text, text)
  to anon, authenticated;
grant execute on function public.ew_publish_update_meta(text, uuid, text, text, text, text, text)
  to anon, authenticated;
