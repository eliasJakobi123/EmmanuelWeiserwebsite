/**
 * @deprecated — Veröffentlichen läuft über Supabase-RPC im Browser (migration_publish_supabase_rpc.sql).
 * Diese Route bleibt nur als Referenz / optionaler Fallback.
 * Vercel Serverless: Arbeiten speichern/löschen (nur mit ADMIN_PUBLISH_PIN).
 */
const { createClient } = require('@supabase/supabase-js')

const MAX_BYTES = 4 * 1024 * 1024

function safeFileName(name) {
  const base = String(name || 'dokument.pdf').split(/[/\\]/).pop()
  return base.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'dokument.pdf'
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    return res.status(204).end()
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  const adminPin = process.env.ADMIN_PUBLISH_PIN

  if (!url || !key || !adminPin) {
    return res.status(503).json({
      error: 'Server nicht konfiguriert (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ADMIN_PUBLISH_PIN).',
    })
  }

  let body = req.body
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body)
    } catch {
      return res.status(400).json({ error: 'Ungültiger JSON-Body' })
    }
  }

  const pin = body.pin
  if (!pin || String(pin) !== String(adminPin)) {
    return res.status(401).json({ error: 'Nicht autorisiert' })
  }

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const action = body.action || 'create'

  try {
    if (action === 'delete') {
      const id = body.id
      if (!id) return res.status(400).json({ error: 'id fehlt' })

      const { data: row, error: fe } = await supabase
        .from('site_published_works')
        .select('pdf_storage_path')
        .eq('id', id)
        .single()

      if (fe) return res.status(400).json({ error: fe.message })
      if (row?.pdf_storage_path) {
        await supabase.storage.from('work-pdfs').remove([row.pdf_storage_path])
      }
      const { error: de } = await supabase.from('site_published_works').delete().eq('id', id)
      if (de) return res.status(400).json({ error: de.message })
      return res.status(200).json({ ok: true })
    }

    const title = String(body.title || '').trim()
    const teaser = String(body.teaser || '').trim()
    const bodyText = String(body.bodyText || '').trim()
    const dateLabel = String(body.dateLabel || '').trim()
    const pdfFileName = safeFileName(body.pdfFileName)

    if (!title || !teaser) {
      return res.status(400).json({ error: 'Titel und Kurzbeschreibung erforderlich' })
    }

    if (action === 'create') {
      const pdfBase64 = body.pdfBase64
      if (!pdfBase64) return res.status(400).json({ error: 'PDF fehlt' })

      const buf = Buffer.from(String(pdfBase64), 'base64')
      if (buf.length > MAX_BYTES) {
        return res.status(400).json({ error: 'PDF zu groß (max. ca. 4 MB für diesen Upload)' })
      }

      const { data: ins, error: ie } = await supabase
        .from('site_published_works')
        .insert({
          title,
          teaser,
          body_text: bodyText,
          date_label: dateLabel,
          pdf_file_name: pdfFileName,
        })
        .select('id')
        .single()

      if (ie) return res.status(400).json({ error: ie.message })
      const workId = ins.id
      const storagePath = `${workId}/${pdfFileName}`

      const { error: ue } = await supabase.storage.from('work-pdfs').upload(storagePath, buf, {
        contentType: 'application/pdf',
        upsert: true,
      })
      if (ue) {
        await supabase.from('site_published_works').delete().eq('id', workId)
        return res.status(400).json({ error: ue.message })
      }

      const { error: ue2 } = await supabase
        .from('site_published_works')
        .update({ pdf_storage_path: storagePath, updated_at: new Date().toISOString() })
        .eq('id', workId)

      if (ue2) return res.status(400).json({ error: ue2.message })
      return res.status(200).json({ ok: true, id: workId })
    }

    if (action === 'update') {
      const id = body.id
      if (!id) return res.status(400).json({ error: 'id fehlt' })

      const { data: prev, error: pe } = await supabase
        .from('site_published_works')
        .select('pdf_storage_path, pdf_file_name')
        .eq('id', id)
        .single()

      if (pe || !prev) return res.status(404).json({ error: 'Eintrag nicht gefunden' })

      let newPath = prev.pdf_storage_path
      let newPdfName = prev.pdf_file_name

      if (body.pdfBase64) {
        const buf = Buffer.from(String(body.pdfBase64), 'base64')
        if (buf.length > MAX_BYTES) {
          return res.status(400).json({ error: 'PDF zu groß (max. ca. 4 MB)' })
        }
        if (prev.pdf_storage_path) {
          await supabase.storage.from('work-pdfs').remove([prev.pdf_storage_path])
        }
        newPdfName = pdfFileName
        newPath = `${id}/${newPdfName}`
        const { error: upE } = await supabase.storage.from('work-pdfs').upload(newPath, buf, {
          contentType: 'application/pdf',
          upsert: true,
        })
        if (upE) return res.status(400).json({ error: upE.message })
      }

      const patch = {
        title,
        teaser,
        body_text: bodyText,
        date_label: dateLabel,
        updated_at: new Date().toISOString(),
      }
      if (body.pdfBase64) {
        patch.pdf_file_name = newPdfName
        patch.pdf_storage_path = newPath
      }

      const { error: upe } = await supabase.from('site_published_works').update(patch).eq('id', id)

      if (upe) return res.status(400).json({ error: upe.message })
      return res.status(200).json({ ok: true, id })
    }

    return res.status(400).json({ error: 'Unbekannte action' })
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Serverfehler' })
  }
}
