-- Einmalig im Supabase SQL Editor ausführen, wenn sich erlaubte work_ids ändern.

drop policy if exists "work_comments_insert_anon" on public.work_comments;

create policy "work_comments_insert_anon"
  on public.work_comments for insert
  to anon, authenticated
  with check (
    work_id in (
      'markus-historisch',
      'matthaeus-judentum',
      'taufe-jesu-synoptisch',
      'lukas-identitaet-sendung'
    )
    and length(trim(body)) >= 1
    and length(body) <= 4000
    and (author_name is null or length(author_name) <= 80)
  );
