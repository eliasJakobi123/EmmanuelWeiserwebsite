/**
 * Versteckte Verwaltung + Veröffentlichen über Supabase (RPC + Storage).
 * Feste Arbeiten: BUILTIN_ROWS. Hochgeladene: Tabelle site_published_works (öffentlich lesbar).
 * PIN: SHA-256-Prüfsumme im Skript; dieselbe Prüfsumme in Supabase (_ew_publish_secret).
 */
import sha256 from 'js-sha256'
import { WORK_LEGAL_FOOTER_HTML } from './legal-footer.js'
import { getSupabase } from './supabase-client.js'

const ADMIN_PIN_SHA256_HEX =
  '3bbcf69de876e98ac944c5276eaeb44308c00a4e89260ad0067c7c9aeb4532b8'
const SESSION_KEY = 'ew_adm'
/** Klartext-PIN nur für diese Browser-Sitzung (Tab), für Supabase-RPC — zusammen mit SESSION_KEY */
const SESSION_PIN_KEY = 'ew_pin'
const LS_META = 'ew_custom_works_v1'
const DB_NAME = 'ew-works-v1'
const STORE = 'pdfBlobs'
const PREFIX = 'ew-c-'
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Klartext-PIN für Veröffentlichen/Löschen (RAM + sessionStorage, Tab zu) */
let unlockedPin = ''

const BUILTIN_ROWS = [
  {
    id: 'matthaeus-judentum',
    dateLabel: 'Februar 2026',
    title: 'Antijudaismus bei Mattheaus',
    teaser:
      'Matthäusevangelium, narrative Polemik und das Verhältnis von innerjüdischer Auseinandersetzung zu Wirkungsgeschichte.',
    custom: false,
  },
  {
    id: 'taufe-jesu-synoptisch',
    dateLabel: 'Februar 2026',
    title: 'Die Taufe Jesu',
    teaser:
      'Synoptischer Vergleich und außerkanonische Rezeption der Tauf- und Versuchungstradition.',
    custom: false,
  },
  {
    id: 'lukas-identitaet-sendung',
    dateLabel: 'Januar 2026',
    title: 'Soteriologie im Evangelium nach Lukas',
    teaser:
      'Transformation der markinischen Vorlage in Tauferzählung und Erlösungslehre des Lukasevangeliums.',
    custom: false,
  },
]

function esc(s) {
  const d = document.createElement('div')
  d.textContent = s == null ? '' : String(s)
  return d.innerHTML
}

export function formatCustomBodyHtml(raw) {
  const t = String(raw || '').trim()
  if (!t) return '<p class="text-gray-700 leading-relaxed italic">(Kein Langtext)</p>'
  return t
    .split(/\n\n+/)
    .map((block) => {
      const lines = block.split('\n').map((line) => esc(line)).join('<br/>')
      return `<p class="text-gray-700 leading-relaxed mb-4">${lines}</p>`
    })
    .join('')
}

/** @returns {boolean} */
function verifyPin(input) {
  try {
    return sha256(String(input).trim()) === ADMIN_PIN_SHA256_HEX
  } catch {
    return false
  }
}

function isAdminSession() {
  try {
    return sessionStorage.getItem(SESSION_KEY) === '1'
  } catch {
    return false
  }
}

/** Nach Reload: PIN aus sessionStorage holen. Altes ew_adm ohne ew_pin → Session ungültig. */
function restorePublishPinFromSession() {
  try {
    if (!isAdminSession()) {
      unlockedPin = ''
      return
    }
    const p = sessionStorage.getItem(SESSION_PIN_KEY)
    if (p) {
      unlockedPin = p
    } else {
      sessionStorage.removeItem(SESSION_KEY)
      unlockedPin = ''
    }
  } catch {
    unlockedPin = ''
  }
}

function persistPublishPin(plainPin) {
  try {
    if (plainPin) sessionStorage.setItem(SESSION_PIN_KEY, String(plainPin))
    else sessionStorage.removeItem(SESSION_PIN_KEY)
  } catch {
    /* ignore */
  }
}

function setAdminSession(on) {
  try {
    if (on) sessionStorage.setItem(SESSION_KEY, '1')
    else {
      sessionStorage.removeItem(SESSION_KEY)
      sessionStorage.removeItem(SESSION_PIN_KEY)
    }
  } catch {
    /* ignore */
  }
  if (!on) unlockedPin = ''
  updateAdminChrome()
}

function readMetaList() {
  try {
    const raw = localStorage.getItem(LS_META)
    if (!raw) return []
    const p = JSON.parse(raw)
    return Array.isArray(p) ? p : []
  } catch {
    return []
  }
}

let dbPromise = null
function openDb() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

async function idbPutPdf(id, blob) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(blob, id)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function idbGetPdf(id) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const r = tx.objectStore(STORE).get(id)
    r.onsuccess = () => resolve(r.result || null)
    r.onerror = () => reject(r.error)
  })
}

async function idbDelPdf(id) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(id)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/**
 * Legacy: nur noch lokale Entwürfe mit Präfix ew-c-
 * @returns {Promise<{ bodyHtml: string, pdf: { blob: Blob, fileName: string, label: string } } | null>}
 */
export async function loadCustomExtended(workId) {
  if (!workId || !workId.startsWith(PREFIX)) return null
  const list = readMetaList()
  const meta = list.find((m) => m.id === workId)
  if (!meta) return null
  const blob = await idbGetPdf(workId)
  if (!blob) return null
  return {
    bodyHtml: formatCustomBodyHtml(meta.bodyText) + WORK_LEGAL_FOOTER_HTML,
    pdf: {
      blob,
      fileName: meta.pdfFileName || 'arbeit.pdf',
      label: meta.title,
    },
  }
}

const REMOTE_FETCH_MS = 10_000

async function fetchRemoteRows() {
  const supabase = await getSupabase()
  if (!supabase) return []
  try {
    const query = supabase
      .from('site_published_works')
      .select('id, title, teaser, date_label, created_at')
      .order('created_at', { ascending: false })
    const { data, error } = await Promise.race([
      query,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('site_published_works timeout')), REMOTE_FETCH_MS),
      ),
    ])
    if (error || !data?.length) return []
    const builtinIds = new Set(BUILTIN_ROWS.map((r) => r.id))
    return data
      .filter((row) => row.id && !builtinIds.has(row.id))
      .map((row) => ({
        id: row.id,
        dateLabel: row.date_label || '',
        title: row.title,
        teaser: row.teaser,
        custom: true,
        remote: true,
      }))
  } catch {
    return []
  }
}

function updateAdminChrome() {
  const bar = document.getElementById('works-admin-bar')
  if (bar) bar.classList.toggle('hidden', !isAdminSession())
  const unlock = document.getElementById('contact-admin-unlock')
  const active = document.getElementById('contact-admin-active')
  if (unlock) unlock.classList.toggle('hidden', isAdminSession())
  if (active) active.classList.toggle('hidden', !isAdminSession())
}

export async function renderWorksList() {
  const root = document.getElementById('works-list-root')
  if (!root) return
  root.innerHTML = ''
  const remote = await fetchRemoteRows()
  const legacyLocal = readMetaList()
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .map((c) => ({ ...c, custom: true, remote: false, legacy: true }))
  const admin = isAdminSession()
  /* Neueste DB-Arbeiten zuerst (fetchRemoteRows: created_at desc), danach feste Built-ins, zuletzt lokale Legacy. */
  const rows = [...remote, ...BUILTIN_ROWS, ...legacyLocal]

  rows.forEach((row) => {
    const wrap = document.createElement('div')
    wrap.className =
      'hover-lift group grid md:grid-cols-4 gap-4 items-start cursor-pointer border-b border-transparent pb-8 last:border-0 last:pb-0'

    const open = () => {
      window.openDetail(row.id, row.title, row.teaser, 'Manuskript')
    }

    wrap.addEventListener('click', (e) => {
      if (e.target.closest('[data-stop-open]')) return
      open()
    })

    const colDate = document.createElement('div')
    colDate.className = 'text-[10px] uppercase tracking-widest text-gray-400 pt-2 font-mono'
    colDate.textContent = row.dateLabel || ''

    const colMain = document.createElement('div')
    colMain.className = 'md:col-span-2'
    colMain.innerHTML = `
      <h4 class="text-xl serif mb-2 group-hover:text-stone-500 transition-colors leading-snug">${esc(row.title)}</h4>
      <p class="text-sm text-gray-500 leading-relaxed">${esc(row.teaser)}</p>
      <p class="text-[10px] text-stone-400 leading-relaxed mt-3">Urheberrechtlich geschützt — Vervielfältigung nur mit Zustimmung des Urhebers.</p>
    `

    if (admin && row.custom) {
      const tools = document.createElement('div')
      tools.className = 'mt-4 flex flex-wrap gap-3'
      tools.setAttribute('data-stop-open', '1')
      const btnEd = document.createElement('button')
      btnEd.type = 'button'
      btnEd.className =
        'text-[10px] uppercase tracking-widest border border-stone-300 px-4 py-2 hover:bg-stone-900 hover:text-white hover:border-stone-900 transition'
      btnEd.textContent = 'Bearbeiten'
      btnEd.addEventListener('click', (e) => {
        e.stopPropagation()
        void openArticleEditor(row.id)
      })
      tools.appendChild(btnEd)
      colMain.appendChild(tools)
    }

    const colOpen = document.createElement('div')
    colOpen.className = 'md:text-right text-xs uppercase tracking-widest text-stone-400'
    colOpen.textContent = 'Öffnen'

    wrap.appendChild(colDate)
    wrap.appendChild(colMain)
    wrap.appendChild(colOpen)
    root.appendChild(wrap)
  })

  updateAdminChrome()
}

async function submitContactPin() {
  const inp = document.getElementById('contact-admin-pin')
  const err = document.getElementById('contact-admin-error')
  err?.classList.add('hidden')
  if (isAdminSession()) {
    void openArticleEditor(null)
    return
  }
  const ok = verifyPin(inp?.value || '')
  if (ok) {
    unlockedPin = String(inp?.value || '').trim()
    persistPublishPin(unlockedPin)
    setAdminSession(true)
    if (inp) inp.value = ''
    try {
      await renderWorksList()
    } catch {
      /* ignore */
    }
    void openArticleEditor(null)
  } else {
    unlockedPin = ''
    persistPublishPin('')
    err?.classList.remove('hidden')
  }
}

function setupContactAdminPin() {
  const inp = document.getElementById('contact-admin-pin')
  const btn = document.getElementById('contact-admin-submit')
  if (!inp || !btn) return
  btn.addEventListener('click', () => void submitContactPin())
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void submitContactPin()
  })
}

let editingArticleId = null
let pendingPdfFile = null
let editingPdfFileName = ''

function setPdfEditUi(mode, currentPdfName = '') {
  const pdfLabel = document.getElementById('admin-article-pdf-label')
  const pdfCurrent = document.getElementById('admin-article-pdf-current')
  const dropHint = document.getElementById('admin-article-drop-hint')
  const saveBtn = document.getElementById('admin-article-save')
  const isEdit = mode === 'edit'

  if (pdfLabel) pdfLabel.textContent = isEdit ? 'PDF bearbeiten' : 'PDF'
  if (pdfCurrent) {
    if (isEdit) {
      pdfCurrent.textContent = currentPdfName
        ? `Aktuelle Datei: ${currentPdfName}`
        : 'Keine PDF hinterlegt'
      pdfCurrent.classList.remove('hidden')
    } else {
      pdfCurrent.textContent = ''
      pdfCurrent.classList.add('hidden')
    }
  }
  if (saveBtn) saveBtn.textContent = isEdit ? 'Speichern' : 'Veröffentlichen'
  if (dropHint && !pendingPdfFile) {
    dropHint.textContent = isEdit
      ? 'Neue PDF wählen oder hierher ziehen — die bisherige Datei wird ersetzt'
      : 'PDF hierher ziehen oder klicken'
  }
}

function updatePdfDropHintAfterSelect(fileName) {
  const hint = document.getElementById('admin-article-drop-hint')
  if (!hint) return
  if (editingArticleId) {
    hint.textContent = `Neue Datei: ${fileName} — ersetzt beim Speichern die bisherige PDF`
  } else {
    hint.textContent = fileName
  }
}

async function openArticleEditor(id) {
  editingArticleId = id || null
  pendingPdfFile = null
  editingPdfFileName = ''
  const m = document.getElementById('admin-article-modal')
  const title = document.getElementById('admin-article-title')
  const teaser = document.getElementById('admin-article-teaser')
  const body = document.getElementById('admin-article-body')
  const date = document.getElementById('admin-article-date')
  const dropHint = document.getElementById('admin-article-drop-hint')
  const h = document.getElementById('admin-article-heading')
  if (!m || !title || !teaser || !body || !date || !h || !dropHint) return

  const fileIn = document.getElementById('admin-article-file')
  if (fileIn) fileIn.value = ''
  document.getElementById('admin-article-delete')?.classList.toggle('hidden', !id)

  if (id && UUID_V4.test(id)) {
    const supabase = await getSupabase()
    if (!supabase) {
      alert('Supabase ist nicht konfiguriert.')
      return
    }
    const { data, error } = await supabase.from('site_published_works').select('*').eq('id', id).single()
    if (error || !data) {
      alert('Eintrag konnte nicht geladen werden.')
      return
    }
    h.textContent = 'Arbeit bearbeiten'
    title.value = data.title
    teaser.value = data.teaser
    body.value = data.body_text || ''
    date.value = data.date_label || ''
    editingPdfFileName = data.pdf_file_name || ''
    setPdfEditUi('edit', editingPdfFileName)
  } else if (id && id.startsWith(PREFIX)) {
    const meta = readMetaList().find((x) => x.id === id)
    if (!meta) return
    h.textContent = 'Arbeit bearbeiten (nur lokal)'
    title.value = meta.title
    teaser.value = meta.teaser
    body.value = meta.bodyText
    date.value = meta.dateLabel || ''
    editingPdfFileName = meta.pdfFileName || ''
    setPdfEditUi('edit', editingPdfFileName)
  } else {
    h.textContent = 'Neuer Artikel'
    title.value = ''
    teaser.value = ''
    body.value = ''
    date.value = defaultDateLabel()
    setPdfEditUi('new')
  }

  m.classList.add('is-open')
  title.focus()
}

function defaultDateLabel() {
  try {
    return new Date().toLocaleDateString('de-DE', { month: 'long', year: 'numeric' })
  } catch {
    return ''
  }
}

function closeArticleModal() {
  document.getElementById('admin-article-modal')?.classList.remove('is-open')
  editingArticleId = null
  pendingPdfFile = null
  editingPdfFileName = ''
}

function wireDropZone() {
  const drop = document.getElementById('admin-article-drop')
  const input = document.getElementById('admin-article-file')
  if (!drop || !input) return

  const setFile = (file) => {
    if (!file || file.type !== 'application/pdf') {
      alert('Bitte eine PDF-Datei wählen.')
      return
    }
    if (file.size > 4 * 1024 * 1024) {
      alert('Die PDF ist zu groß (max. 4 MB für den Server-Upload).')
      return
    }
    pendingPdfFile = file
    updatePdfDropHintAfterSelect(file.name)
  }

  drop.addEventListener('click', () => input.click())
  input.addEventListener('change', () => {
    const f = input.files?.[0]
    if (f) setFile(f)
  })
  drop.addEventListener('dragover', (e) => {
    e.preventDefault()
    drop.classList.add('border-black', 'bg-stone-50')
  })
  drop.addEventListener('dragleave', () => {
    drop.classList.remove('border-black', 'bg-stone-50')
  })
  drop.addEventListener('drop', (e) => {
    e.preventDefault()
    drop.classList.remove('border-black', 'bg-stone-50')
    const f = e.dataTransfer?.files?.[0]
    if (f) setFile(f)
  })
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => {
      const s = String(r.result || '')
      const i = s.indexOf(',')
      resolve(i >= 0 ? s.slice(i + 1) : s)
    }
    r.onerror = reject
    r.readAsDataURL(file)
  })
}

function safeFileName(name) {
  const base = String(name || 'dokument.pdf').split(/[/\\]/).pop()
  return base.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'dokument.pdf'
}

function base64ToBytes(b64) {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Veröffentlichen/Löschen direkt über Supabase (RPC + Storage) — kein Vercel-API-Route nötig. */
async function publishRemoteViaSupabase() {
  restorePublishPinFromSession()
  const supabase = await getSupabase()
  if (!supabase) {
    alert('Supabase ist nicht konfiguriert (VITE_SUPABASE_URL und VITE_SUPABASE_ANON_KEY).')
    return false
  }
  const pin = unlockedPin
  const title = document.getElementById('admin-article-title')?.value?.trim()
  const teaser = document.getElementById('admin-article-teaser')?.value?.trim()
  const bodyText = document.getElementById('admin-article-body')?.value?.trim()
  const dateLabel = document.getElementById('admin-article-date')?.value?.trim()
  if (!title || !teaser) {
    alert('Bitte Überschrift und Kurzbeschreibung ausfüllen.')
    return false
  }

  if (editingArticleId && UUID_V4.test(editingArticleId)) {
    const { error: eMeta } = await supabase.rpc('ew_publish_update_meta', {
      p_pin: pin,
      p_id: editingArticleId,
      p_title: title,
      p_teaser: teaser,
      p_body_text: bodyText || '',
      p_date_label: dateLabel || '',
    })
    if (eMeta) {
      alert(eMeta.message || 'Speichern fehlgeschlagen.')
      return false
    }

    if (pendingPdfFile) {
      const { error: eRm } = await supabase.rpc('ew_publish_remove_pdf', {
        p_pin: pin,
        p_work_id: editingArticleId,
      })
      if (eRm) {
        alert(eRm.message || 'Altes PDF konnte nicht freigegeben werden.')
        return false
      }
      const pdfBase64 = await fileToBase64(pendingPdfFile)
      const fname = safeFileName(pendingPdfFile.name)
      const pdfPath = `${editingArticleId}/${fname}`
      const bytes = base64ToBytes(pdfBase64)
      const { error: eUp } = await supabase.storage.from('work-pdfs').upload(pdfPath, bytes, {
        contentType: 'application/pdf',
        upsert: true,
      })
      if (eUp) {
        alert(eUp.message || 'PDF-Upload fehlgeschlagen.')
        return false
      }
      const { error: eFin } = await supabase.rpc('ew_publish_finalize_pdf', {
        p_pin: pin,
        p_work_id: editingArticleId,
        p_path: pdfPath,
        p_pdf_file_name: fname,
      })
      if (eFin) {
        alert(eFin.message || 'PDF konnte nicht zugeordnet werden.')
        return false
      }
    }
    return true
  }

  if (!pendingPdfFile) {
    alert('Bitte eine PDF-Datei hinzufügen.')
    return false
  }
  const pdfBase64 = await fileToBase64(pendingPdfFile)
  const fname = safeFileName(pendingPdfFile.name)

  const { data: workId, error: eCreate } = await supabase.rpc('ew_publish_create', {
    p_pin: pin,
    p_title: title,
    p_teaser: teaser,
    p_body_text: bodyText || '',
    p_date_label: dateLabel || '',
  })
  if (eCreate || !workId) {
    alert(eCreate?.message || 'Anlegen fehlgeschlagen. Migration publish-RPC in Supabase ausgeführt?')
    return false
  }

  const pdfPath = `${workId}/${fname}`
  const bytes = base64ToBytes(pdfBase64)
  const { error: eUp } = await supabase.storage.from('work-pdfs').upload(pdfPath, bytes, {
    contentType: 'application/pdf',
    upsert: true,
  })
  if (eUp) {
    await supabase.rpc('ew_publish_delete', { p_pin: pin, p_id: workId })
    alert(eUp.message || 'PDF-Upload fehlgeschlagen.')
    return false
  }
  const { error: eFin } = await supabase.rpc('ew_publish_finalize_pdf', {
    p_pin: pin,
    p_work_id: workId,
    p_path: pdfPath,
    p_pdf_file_name: fname,
  })
  if (eFin) {
    await supabase.rpc('ew_publish_delete', { p_pin: pin, p_id: workId })
    alert(eFin.message || 'Veröffentlichen nicht abgeschlossen.')
    return false
  }
  return true
}

async function publishArticle() {
  restorePublishPinFromSession()
  const title = document.getElementById('admin-article-title')?.value?.trim()
  const teaser = document.getElementById('admin-article-teaser')?.value?.trim()
  const bodyText = document.getElementById('admin-article-body')?.value?.trim()
  const dateLabel = document.getElementById('admin-article-date')?.value?.trim()
  if (!title || !teaser) {
    alert('Bitte Überschrift und Kurzbeschreibung ausfüllen.')
    return
  }

  if (!unlockedPin) {
    alert('Bitte die Verwaltung zuerst im Kontaktbereich mit dem Zugangscode freischalten.')
    return
  }

  if (editingArticleId && editingArticleId.startsWith(PREFIX)) {
    await publishLocalLegacy()
    return
  }

  try {
    const ok = await publishRemoteViaSupabase()
    if (!ok) return
  } catch (e) {
    console.error(e)
    alert(e?.message || 'Veröffentlichen fehlgeschlagen.')
    return
  }

  closeArticleModal()
  await renderWorksList()
}

/** Alte rein lokale Einträge (ew-c-) — nur noch Bearbeiten */
async function publishLocalLegacy() {
  if (!editingArticleId || !editingArticleId.startsWith(PREFIX)) return
  const title = document.getElementById('admin-article-title')?.value?.trim()
  const teaser = document.getElementById('admin-article-teaser')?.value?.trim()
  const bodyText = document.getElementById('admin-article-body')?.value?.trim()
  const dateLabel = document.getElementById('admin-article-date')?.value?.trim()
  const id = editingArticleId
  const list = readMetaList()
  const idx = list.findIndex((x) => x.id === editingArticleId)
  if (idx < 0) return
  const prev = list[idx]
  const pdfFileName = pendingPdfFile ? pendingPdfFile.name : prev.pdfFileName
  if (!pdfFileName) {
    alert('Bitte eine PDF-Datei zuweisen.')
    return
  }
  if (pendingPdfFile) {
    await idbDelPdf(id)
    await idbPutPdf(id, pendingPdfFile)
  }
  list[idx] = {
    ...prev,
    title,
    teaser,
    bodyText: bodyText || '',
    dateLabel: dateLabel || defaultDateLabel(),
    pdfFileName,
    updatedAt: Date.now(),
  }
  localStorage.setItem(LS_META, JSON.stringify(list))
  closeArticleModal()
  await renderWorksList()
}

async function deleteCurrentArticle() {
  if (!editingArticleId) return
  if (!confirm('Diese Arbeit wirklich löschen?')) return

  if (UUID_V4.test(editingArticleId)) {
    restorePublishPinFromSession()
    const pin = unlockedPin
    if (!pin) {
      alert('Verwaltung erneut freischalten.')
      return
    }
    const supabase = await getSupabase()
    if (!supabase) {
      alert('Supabase ist nicht konfiguriert.')
      return
    }
    const { error } = await supabase.rpc('ew_publish_delete', {
      p_pin: pin,
      p_id: editingArticleId,
    })
    if (error) {
      alert(error.message || 'Löschen fehlgeschlagen.')
      return
    }
  } else {
    const list = readMetaList().filter((x) => x.id !== editingArticleId)
    localStorage.setItem(LS_META, JSON.stringify(list))
    await idbDelPdf(editingArticleId)
  }
  closeArticleModal()
  await renderWorksList()
}

export async function initAdminWorks() {
  /* PIN wiederherstellen (nach Reload), sonst nur Session-Flag aber kein Klartext für RPC. */
  restorePublishPinFromSession()
  /* Listener sofort — nicht hinter await renderWorksList() (Supabase kann hängen). */
  setupContactAdminPin()
  wireDropZone()
  updateAdminChrome()

  document.getElementById('btn-new-article')?.addEventListener('click', () => void openArticleEditor(null))

  document.getElementById('admin-article-save')?.addEventListener('click', () => {
    void publishArticle()
  })
  document.getElementById('admin-article-cancel')?.addEventListener('click', closeArticleModal)
  document.getElementById('admin-article-delete')?.addEventListener('click', () => {
    void deleteCurrentArticle()
  })
  document.getElementById('admin-article-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'admin-article-modal') closeArticleModal()
  })

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeArticleModal()
  })

  try {
    await renderWorksList()
  } catch (err) {
    console.error('renderWorksList', err)
  }
}
