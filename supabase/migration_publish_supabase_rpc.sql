-- Nach migration_site_published_works.sql ausführen.
-- Veröffentlichen direkt über Supabase (RPC + Storage), ohne Vercel-API.
-- Der PIN muss dieselbe SHA-256-Prüfsumme ergeben wie in src/admin-works.js (ADMIN_PIN_SHA256_HEX).
-- Wenn du den Zugangscode im Frontend änderst: Hash dort neu berechnen und diese Zeile anpassen.

create extension if not exists pgcrypto with schema extensions;

-- Geheimnis nur für RPC (kein SELECT für anon)
create table if not exists public._ew_publish_secret (
  id int primary key default 1 check (id = 1),
  pin_sha256_hex text not null
);

alter table public._ew_publish_secret enable row level security;

-- Keine Policies für anon/authenticated = kein direkter Zugriff

-- Muss zu ADMIN_PIN_SHA256_HEX in admin-works.js passen (gleicher PIN)
insert into public._ew_publish_secret (id, pin_sha256_hex)
values (1, '3bbcf69de876e98ac944c5276eaeb44308c00a4e89260ad0067c7c9aeb4532b8')
on conflict (id) do update set pin_sha256_hex = excluded.pin_sha256_hex;

-- PDF-Upload: nur wenn Zeile existiert und noch kein PDF gesetzt (oder gleicher Pfad für Ersetzung)
drop policy if exists "work_pdfs_upload_pending" on storage.objects;
create policy "work_pdfs_upload_pending"
  on storage.objects for insert
  to anon, authenticated
  with check (
    bucket_id = 'work-pdfs'
    and exists (
      select 1
      from public.site_published_works w
      where w.id::text = split_part(name, '/', 1)
        and (w.pdf_storage_path is null or w.pdf_storage_path = name)
    )
  );

create or replace function public.ew_publish_create(
  p_pin text,
  p_title text,
  p_teaser text,
  p_body_text text,
  p_date_label text
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
begin
  select s.pin_sha256_hex into v_expected from public._ew_publish_secret s where s.id = 1;
  v_actual := encode(extensions.digest(convert_to(trim(p_pin), 'UTF8'), 'sha256'), 'hex');
  if v_actual is distinct from v_expected then
    raise exception 'invalid pin';
  end if;
  if length(trim(p_title)) = 0 or length(trim(p_teaser)) = 0 then
    raise exception 'title and teaser required';
  end if;
  insert into public.site_published_works (title, teaser, body_text, date_label)
  values (trim(p_title), trim(p_teaser), coalesce(trim(p_body_text), ''), nullif(trim(p_date_label), ''))
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.ew_publish_finalize_pdf(
  p_pin text,
  p_work_id uuid,
  p_path text,
  p_pdf_file_name text
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
begin
  select s.pin_sha256_hex into v_expected from public._ew_publish_secret s where s.id = 1;
  v_actual := encode(extensions.digest(convert_to(trim(p_pin), 'UTF8'), 'sha256'), 'hex');
  if v_actual is distinct from v_expected then
    raise exception 'invalid pin';
  end if;
  update public.site_published_works
  set
    pdf_storage_path = p_path,
    pdf_file_name = p_pdf_file_name,
    updated_at = now()
  where id = p_work_id
    and pdf_storage_path is null
  returning id into v_ok;
  if v_ok is null then
    raise exception 'finalize failed: work missing or pdf already set';
  end if;
end;
$$;

create or replace function public.ew_publish_update_meta(
  p_pin text,
  p_id uuid,
  p_title text,
  p_teaser text,
  p_body_text text,
  p_date_label text
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
begin
  select s.pin_sha256_hex into v_expected from public._ew_publish_secret s where s.id = 1;
  v_actual := encode(extensions.digest(convert_to(trim(p_pin), 'UTF8'), 'sha256'), 'hex');
  if v_actual is distinct from v_expected then
    raise exception 'invalid pin';
  end if;
  if length(trim(p_title)) = 0 or length(trim(p_teaser)) = 0 then
    raise exception 'title and teaser required';
  end if;
  update public.site_published_works
  set
    title = trim(p_title),
    teaser = trim(p_teaser),
    body_text = coalesce(trim(p_body_text), ''),
    date_label = nullif(trim(p_date_label), ''),
    updated_at = now()
  where id = p_id
  returning id into v_ok;
  if v_ok is null then
    raise exception 'update failed: not found';
  end if;
end;
$$;

create or replace function public.ew_publish_remove_pdf(
  p_pin text,
  p_work_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_expected text;
  v_actual text;
  v_path text;
begin
  select s.pin_sha256_hex into v_expected from public._ew_publish_secret s where s.id = 1;
  v_actual := encode(extensions.digest(convert_to(trim(p_pin), 'UTF8'), 'sha256'), 'hex');
  if v_actual is distinct from v_expected then
    raise exception 'invalid pin';
  end if;
  select w.pdf_storage_path into v_path from public.site_published_works w where w.id = p_work_id;
  if v_path is not null then
    begin
      delete from storage.objects where bucket_id = 'work-pdfs' and name = v_path;
    exception
      when others then
        null;
    end;
  end if;
  update public.site_published_works
  set pdf_storage_path = null, pdf_file_name = null, updated_at = now()
  where id = p_work_id;
end;
$$;

create or replace function public.ew_publish_delete(
  p_pin text,
  p_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_expected text;
  v_actual text;
  v_path text;
begin
  select s.pin_sha256_hex into v_expected from public._ew_publish_secret s where s.id = 1;
  v_actual := encode(extensions.digest(convert_to(trim(p_pin), 'UTF8'), 'sha256'), 'hex');
  if v_actual is distinct from v_expected then
    raise exception 'invalid pin';
  end if;
  select w.pdf_storage_path into v_path from public.site_published_works w where w.id = p_id;
  delete from public.site_published_works where id = p_id;
  if not found then
    raise exception 'delete failed: not found';
  end if;
  if v_path is not null then
    begin
      delete from storage.objects where bucket_id = 'work-pdfs' and name = v_path;
    exception
      when others then
        null;
    end;
  end if;
end;
$$;

grant execute on function public.ew_publish_create(text, text, text, text, text) to anon, authenticated;
grant execute on function public.ew_publish_finalize_pdf(text, uuid, text, text) to anon, authenticated;
grant execute on function public.ew_publish_update_meta(text, uuid, text, text, text, text) to anon, authenticated;
grant execute on function public.ew_publish_remove_pdf(text, uuid) to anon, authenticated;
grant execute on function public.ew_publish_delete(text, uuid) to anon, authenticated;
