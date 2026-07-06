-- Öffentlich sichtbare, per Vercel-API verwaltete Arbeiten (Metadaten + PDF-Pfad im Storage)

create table if not exists public.site_published_works (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  teaser text not null,
  body_text text not null default '',
  date_label text,
  pdf_storage_path text,
  pdf_file_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_site_published_works_created on public.site_published_works (created_at desc);

alter table public.site_published_works enable row level security;

drop policy if exists "site_published_works_select_public" on public.site_published_works;
create policy "site_published_works_select_public"
  on public.site_published_works for select
  to anon, authenticated
  using (true);

-- Schreiben nur über Service Role (Vercel API), nicht für anon

insert into storage.buckets (id, name, public)
values ('work-pdfs', 'work-pdfs', true)
on conflict (id) do nothing;

drop policy if exists "work_pdfs_public_read" on storage.objects;
create policy "work_pdfs_public_read"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'work-pdfs');
