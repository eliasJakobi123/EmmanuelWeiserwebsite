-- Einmalig im Supabase Dashboard → SQL Editor ausführen (als postgres / Owner).
-- Löscht die NEUERE der doppelten Arbeiten zu „Die ersten Jüngerberufungen … plausibles Modell“,
-- behält die ältere (zuerst hochgeladene). Nur wenn mindestens 2 passende Zeilen existieren.
--
-- Stattdessen die ÄLTERE löschen? Im Block unten ändern:
--   ORDER BY created_at DESC  →  ORDER BY created_at ASC

DO $$
DECLARE
  cnt int;
  del_id uuid;
  del_path text;
BEGIN
  SELECT count(*) INTO cnt
  FROM public.site_published_works
  WHERE title ILIKE '%Jüngerberufungen%'
    AND title ILIKE '%plausibles%Modell%';

  IF cnt < 2 THEN
    RAISE NOTICE 'Abbruch: Es gibt % passende Zeile(n); mindestens 2 nötig zum automatischen Löschen.', cnt;
    RETURN;
  END IF;

  SELECT id, pdf_storage_path INTO del_id, del_path
  FROM public.site_published_works
  WHERE title ILIKE '%Jüngerberufungen%'
    AND title ILIKE '%plausibles%Modell%'
  ORDER BY created_at DESC
  LIMIT 1;

  RAISE NOTICE 'Lösche Eintrag id=% (PDF-Pfad: %)', del_id, del_path;

  IF del_path IS NOT NULL THEN
    BEGIN
      DELETE FROM storage.objects
      WHERE bucket_id = 'work-pdfs' AND name = del_path;
    EXCEPTION
      WHEN OTHERS THEN
        RAISE NOTICE 'Hinweis: PDF in storage.objects konnte nicht gelöscht werden: %', SQLERRM;
    END;
  END IF;

  DELETE FROM public.site_published_works WHERE id = del_id;

  RAISE NOTICE 'Fertig: Duplikat entfernt (neuere Version).';
END $$;

-- Optional: danach prüfen
-- SELECT id, title, created_at FROM public.site_published_works
-- WHERE title ILIKE '%Jüngerberufungen%' AND title ILIKE '%plausibles%Modell%';
