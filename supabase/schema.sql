-- In Supabase: SQL Editor → New query → ausführen

create table if not exists public.work_comments (
  id uuid primary key default gen_random_uuid(),
  work_id text not null,
  parent_id uuid references public.work_comments (id) on delete cascade,
  body text not null,
  author_name text,
  created_at timestamptz not null default now()
);

create index if not exists idx_work_comments_work on public.work_comments (work_id);
create index if not exists idx_work_comments_parent on public.work_comments (parent_id);

alter table public.work_comments enable row level security;

drop policy if exists "work_comments_select_anon" on public.work_comments;
create policy "work_comments_select_anon"
  on public.work_comments for select
  to anon, authenticated
  using (true);

drop policy if exists "work_comments_insert_anon" on public.work_comments;
create policy "work_comments_insert_anon"
  on public.work_comments for insert
  to anon, authenticated
  with check (
    work_id in (
      'markus-historisch',
      'paulus-fruehchristentum',
      'johannes-textvarianten'
    )
    and length(trim(body)) >= 1
    and length(body) <= 4000
    and (author_name is null or length(author_name) <= 80)
  );

create or replace function public.check_work_comment_parent ()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.parent_id is not null then
    if not exists (
      select 1
      from public.work_comments p
      where p.id = new.parent_id and p.work_id = new.work_id
    ) then
      raise exception 'invalid parent for work';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists tr_work_comments_parent on public.work_comments;
create trigger tr_work_comments_parent
  before insert on public.work_comments
  for each row
  execute procedure public.check_work_comment_parent ();
